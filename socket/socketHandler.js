const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Message = require('../models/Message');
const Chat = require('../models/Chat');

// Store active users
const activeUsers = new Map();

const socketHandler = (io) => {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-password');
      
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.username} (${socket.id})`);

    // Add user to active users
    activeUsers.set(socket.userId, {
      socketId: socket.id,
      user: socket.user,
      connectedAt: new Date()
    });

    // Update user's online status
    User.findByIdAndUpdate(socket.userId, {
      isOnline: true,
      lastSeen: new Date()
    }).exec();

    // Join user to their personal room
    socket.join(`user_${socket.userId}`);

    // Notify other users that this user is online
    socket.broadcast.emit('user_online', {
      userId: socket.userId,
      username: socket.user.username,
      avatar: socket.user.avatar
    });

    // Handle joining a chat room
    socket.on('join_chat', async (data) => {
      try {
        const { chatId } = data;
        
        // Verify user is part of this chat
        const chat = await Chat.findOne({
          _id: chatId,
          participants: socket.userId,
          isActive: true
        });

        if (!chat) {
          socket.emit('error', { message: 'You are not authorized to join this chat' });
          return;
        }

        socket.join(`chat_${chatId}`);
        socket.emit('joined_chat', { chatId });
        
        console.log(`User ${socket.user.username} joined chat ${chatId}`);
      } catch (error) {
        console.error('Join chat error:', error);
        socket.emit('error', { message: 'Error joining chat' });
      }
    });

    // Handle leaving a chat room
    socket.on('leave_chat', (data) => {
      const { chatId } = data;
      socket.leave(`chat_${chatId}`);
      socket.emit('left_chat', { chatId });
    });

    // Handle sending messages
    socket.on('send_message', async (data) => {
      try {
        const { receiverId, content, messageType = 'text' } = data;

        // Validate receiver exists
        const receiver = await User.findById(receiverId);
        if (!receiver) {
          socket.emit('error', { message: 'Receiver not found' });
          return;
        }

        // Create or find chat using participantsKey
        const sortedParticipants = [socket.userId, receiverId].map(id => id.toString()).sort();
        const participantsKey = sortedParticipants.join('_');
        
        let chat = await Chat.findOne({ participantsKey });

        if (!chat) {
          try {
            chat = new Chat({
              participants: [socket.userId, receiverId],
              isActive: true,
            });
            await chat.save();
          } catch (error) {
            // If there's a duplicate key error, try to find the existing chat
            if (error.code === 11000) {
              chat = await Chat.findOne({ participantsKey });
              if (!chat) {
                throw error; // Re-throw if we still can't find it
              }
            } else {
              throw error;
            }
          }
        }

        // Create message
        const message = new Message({
          sender: socket.userId,
          receiver: receiverId,
          content,
          messageType,
          chatId: chat._id
        });

        await message.save();

        // Update chat's last message
        chat.lastMessage = message._id;
        chat.lastMessageAt = new Date();
        await chat.save();

        // Populate message with sender and receiver details
        await message.populate('sender', 'username avatar');
        await message.populate('receiver', 'username avatar');

        // Format message for emission
        const formattedMessage = {
          id: message._id,
          content: message.content,
          messageType: message.messageType,
          sender: {
            id: message.sender._id,
            username: message.sender.username,
            avatar: message.sender.avatar
          },
          receiver: {
            id: message.receiver._id,
            username: message.receiver.username,
            avatar: message.receiver.avatar
          },
          chatId: chat._id,
          timestamp: message.createdAt,
          isRead: message.isRead
        };

        // Emit message to receiver
        io.to(`user_${receiverId}`).emit('new_message', {
          message: formattedMessage
        });

        // Emit message to sender (confirmation)
        socket.emit('message_sent', {
          message: formattedMessage
        });

        // Emit to chat room if users are in the same chat
        io.to(`chat_${chat._id}`).emit('chat_message', {
          message: formattedMessage
        });

      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Error sending message' });
      }
    });

    // Handle typing indicators
    socket.on('typing_start', (data) => {
      const { chatId, receiverId } = data;
      socket.to(`user_${receiverId}`).emit('user_typing', {
        userId: socket.userId,
        username: socket.user.username,
        chatId
      });
    });

    socket.on('typing_stop', (data) => {
      const { chatId, receiverId } = data;
      socket.to(`user_${receiverId}`).emit('user_stopped_typing', {
        userId: socket.userId,
        username: socket.user.username,
        chatId
      });
    });

    // Handle message read status
    socket.on('mark_message_read', async (data) => {
      try {
        const { messageId } = data;
        
        const message = await Message.findByIdAndUpdate(
          messageId,
          { 
            isRead: true, 
            readAt: new Date() 
          },
          { new: true }
        );

        if (message) {
          // Notify sender that message was read
          io.to(`user_${message.sender}`).emit('message_read', {
            messageId: message._id,
            readAt: message.readAt
          });
        }
      } catch (error) {
        console.error('Mark message read error:', error);
      }
    });

    // Handle message deletion
    socket.on('delete_message', async (data) => {
      try {
        const { messageId, chatId } = data;
        
        // Verify user owns the message
        const message = await Message.findById(messageId);
        if (!message) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }

        if (message.sender.toString() !== socket.userId) {
          socket.emit('error', { message: 'Not authorized to delete this message' });
          return;
        }

        // Delete the message
        await Message.deleteOne({ _id: messageId });

        // Update chat's last message if needed
        const chat = await Chat.findById(chatId).populate("lastMessage");
        if (chat && chat.lastMessage && chat.lastMessage._id.toString() === messageId) {
          const latest = await Message.find({ chatId }).sort({ createdAt: -1 }).limit(1);
          if (latest.length > 0) {
            chat.lastMessage = latest[0]._id;
            chat.lastMessageAt = latest[0].createdAt;
          } else {
            chat.lastMessage = null;
            chat.lastMessageAt = null;
          }
          await chat.save();
        }

        // Broadcast deletion to all participants in the chat
        const payload = { messageId, chatId };
        io.to(`chat_${chatId}`).emit('message_deleted', payload);
        
        // Also notify individual users
        io.to(`user_${message.receiver}`).emit('message_deleted', payload);
        socket.emit('message_deleted', payload);
        
        console.log(`Message ${messageId} deleted by ${socket.user.username}`);
      } catch (error) {
        console.error('Delete message error:', error);
        socket.emit('error', { message: 'Error deleting message' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.user.username} (${socket.id})`);

      // Remove user from active users
      activeUsers.delete(socket.userId);

      // Update user's online status
      await User.findByIdAndUpdate(socket.userId, {
        isOnline: false,
        lastSeen: new Date()
      });

      // Notify other users that this user is offline
      socket.broadcast.emit('user_offline', {
        userId: socket.userId,
        username: socket.user.username
      });
    });
  });

  return io;
};

module.exports = socketHandler;