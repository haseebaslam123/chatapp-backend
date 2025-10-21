const express = require("express");
const { body, validationResult } = require("express-validator");
const Message = require("../models/Message");
const Chat = require("../models/Chat");
const User = require("../models/User");
const auth = require("../middleware/auth");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { io } = require("../server");

const router = express.Router();

// File upload storage for message attachments
const uploadsDir = path.join(__dirname, "..", "uploads", "messages");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || "";
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({ storage });

/**
 * @route   POST /api/messages
 * @desc    Send a message
 * @access  Private
 */
router.post(
  "/",
  auth,
  [
    body("receiverId").isMongoId().withMessage("Invalid receiver ID"),
    body("content")
      .notEmpty()
      .withMessage("Message content is required")
      .isLength({ max: 1000 })
      .withMessage("Message cannot exceed 1000 characters"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { receiverId, content, messageType = "text" } = req.body;
      const senderId = req.user._id;

      // ✅ Check if receiver exists
      const receiver = await User.findById(receiverId);
      if (!receiver) {
        return res
          .status(404)
          .json({ success: false, message: "Receiver not found" });
      }

      // ✅ Find or create chat using participantsKey
      const sortedParticipants = [senderId, receiverId].map(id => id.toString()).sort();
      const participantsKey = sortedParticipants.join('_');
      
      let chat = await Chat.findOne({ participantsKey });

      if (!chat) {
        try {
          chat = new Chat({
            participants: [senderId, receiverId],
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

      // ✅ Create new message
      const message = new Message({
        sender: senderId,
        receiver: receiverId,
        content,
        messageType,
        chatId: chat._id,
      });

      await message.save();

      // ✅ Update chat’s last message
      chat.lastMessage = message._id;
      chat.lastMessageAt = new Date();
      await chat.save();

      await message.populate("sender", "username avatar");
      await message.populate("receiver", "username avatar");

      res.status(201).json({
        success: true,
        message: "Message sent successfully",
        data: message,
      });
    } catch (error) {
      console.error("Send message error:", error);
      res.status(500).json({
        success: false,
        message: "Server error while sending message",
      });
    }
  }
);

/**
 * @route   DELETE /api/messages/:id
 * @desc    Delete a message (sender only)
 * @access  Private
 */
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id.toString();

    const message = await Message.findById(id);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    if (message.sender.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this message" });
    }

    const chatId = message.chatId;

    // If this message had a file content stored locally, delete the file
    if (message.messageType === 'image' || message.messageType === 'file') {
      const filePath = path.join(__dirname, '..', message.content);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`Deleted file: ${filePath}`);
        }
      } catch (fileError) {
        console.error(`Error deleting file ${filePath}:`, fileError);
        // Continue with message deletion even if file deletion fails
      }
    }

    await Message.deleteOne({ _id: id });

    // Update chat.lastMessage if needed
    const chat = await Chat.findById(chatId).populate("lastMessage");
    if (chat && chat.lastMessage && chat.lastMessage._id.toString() === id) {
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

    // Notify participants via socket
    if (io && chatId) {
      const payload = { messageId: id, chatId: chatId.toString() };
      io.to(`chat_${chatId}`).emit("message_deleted", payload);
    }

    return res.json({ success: true, message: "Message deleted" });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ success: false, message: "Server error while deleting message" });
  }
});

/**
 * @route   GET /api/messages/chats/list
 * @desc    Get user's chat list
 * @access  Private
 */
router.get("/chats/list", auth, async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id,
      isActive: true,
    })
      .populate("participants", "username avatar isOnline lastSeen")
      .populate("lastMessage")
      .sort({ lastMessageAt: -1 });

    const chatsToCleanup = [];
    const userChatMap = new Map(); // To deduplicate chats by user
    const formattedChats = [];

    for (const chat of chats) {
      // Filter out null participants (deleted users) and find the other participant
      const validParticipants = chat.participants.filter(p => p !== null);
      const otherParticipant = validParticipants.find(
        (p) => p._id.toString() !== req.user._id.toString()
      );

      // Skip chats where the other participant was deleted
      if (!otherParticipant) {
        chatsToCleanup.push(chat._id);
        continue;
      }

      const userId = otherParticipant._id.toString();
      
      // Check if we already have a chat with this user
      if (userChatMap.has(userId)) {
        // Keep the chat with the most recent message
        const existingChat = userChatMap.get(userId);
        const existingLastMessageAt = existingChat.lastMessage?.timestamp || existingChat.createdAt || 0;
        const currentLastMessageAt = chat.lastMessage?.createdAt || chat.createdAt || 0;
        
        if (currentLastMessageAt > existingLastMessageAt) {
          // Replace with the more recent chat
          userChatMap.set(userId, {
            _id: chat._id,
            chatId: chat._id,
            user: {
              id: otherParticipant._id,
              username: otherParticipant.username,
              avatar: otherParticipant.avatar,
              isOnline: otherParticipant.isOnline,
              lastSeen: otherParticipant.lastSeen,
            },
            lastMessage: chat.lastMessage
              ? {
                  content: chat.lastMessage.content,
                  timestamp: chat.lastMessage.createdAt,
                  sender: chat.lastMessage.sender,
                }
              : null,
            unread: 0,
          });
        }
        // If existing chat is more recent, keep it and mark current chat for cleanup
        else {
          chatsToCleanup.push(chat._id);
        }
      } else {
        // First chat with this user
        userChatMap.set(userId, {
          _id: chat._id,
          chatId: chat._id,
          user: {
            id: otherParticipant._id,
            username: otherParticipant.username,
            avatar: otherParticipant.avatar,
            isOnline: otherParticipant.isOnline,
            lastSeen: otherParticipant.lastSeen,
          },
          lastMessage: chat.lastMessage
            ? {
                content: chat.lastMessage.content,
                timestamp: chat.lastMessage.createdAt,
                sender: chat.lastMessage.sender,
              }
            : null,
          unread: 0,
        });
      }
    }

    // Convert map to array and sort by last message timestamp
    const deduplicatedChats = Array.from(userChatMap.values())
      .sort((a, b) => {
        const aTime = a.lastMessage?.timestamp || 0;
        const bTime = b.lastMessage?.timestamp || 0;
        return bTime - aTime;
      });

    // Clean up duplicate chats in the background
    if (chatsToCleanup.length > 0) {
      setImmediate(async () => {
        try {
          await Chat.updateMany(
            { _id: { $in: chatsToCleanup } },
            { isActive: false }
          );
          console.log(`Deactivated ${chatsToCleanup.length} duplicate/orphaned chats`);
        } catch (cleanupError) {
          console.error("Error cleaning up duplicate/orphaned chats:", cleanupError);
        }
      });
    }

    res.json({ success: true, chats: deduplicatedChats });
  } catch (error) {
    console.error("Get chat list error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching chat list",
    });
  }
});

/**
 * @route   GET /api/messages/:chatId
 * @desc    Get messages for a specific chat
 * @access  Private
 */
router.get("/:chatId", auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    // Verify user is participant in this chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user._id
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: "Chat not found or access denied"
      });
    }

    const messages = await Message.find({ chatId })
      .populate("sender", "username avatar")
      .populate("receiver", "username avatar")
      .sort({ createdAt: 1 }); // oldest → newest

    res.json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while fetching messages" });
  }
});



/**
 * @route   POST /api/messages/upload
 * @desc    Upload a file as a message
 * @access  Private
 */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    const senderId = req.user._id;
    const { receiverId } = req.body;

    if (!receiverId) {
      return res.status(400).json({ success: false, message: "receiverId is required" });
    }

    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({ success: false, message: "Receiver not found" });
    }

    // Find or create chat using participantsKey
    const sortedParticipants = [senderId, receiverId].map(id => id.toString()).sort();
    const participantsKey = sortedParticipants.join('_');
    
    let chat = await Chat.findOne({ participantsKey });
    if (!chat) {
      try {
        chat = new Chat({ participants: [senderId, receiverId], isActive: true });
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

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const filePath = `${process.env.REACT_APP_SOCKET_URL}/uploads/messages/${req.file.filename}`;
    const mime = req.file.mimetype || "";
    const messageType = mime.startsWith("image/") ? "image" : "file";

    const message = new Message({
      sender: senderId,
      receiver: receiverId,
      content: filePath,
      messageType,
      chatId: chat._id,
    });
    await message.save();

    chat.lastMessage = message._id;
    chat.lastMessageAt = new Date();
    await chat.save();

    await message.populate("sender", "username avatar");
    await message.populate("receiver", "username avatar");

    const formattedMessage = {
      id: message._id,
      content: message.content,
      messageType: message.messageType,
      sender: { id: message.sender._id, username: message.sender.username, avatar: message.sender.avatar },
      receiver: { id: message.receiver._id, username: message.receiver.username, avatar: message.receiver.avatar },
      chatId: chat._id.toString(),
      timestamp: message.createdAt,
      isRead: message.isRead,
    };

    if (io) {
      io.to(`chat_${chat._id}`).emit("new_message", { message: formattedMessage });
      io.to(`user_${receiverId}`).emit("new_message", { message: formattedMessage });
      io.to(`user_${senderId}`).emit("message_sent", { message: formattedMessage });
    }

    res.status(201).json({ success: true, message: "File message sent", data: message });
  } catch (error) {
    console.error("Upload message error:", error);
    res.status(500).json({ success: false, message: "Server error while uploading message" });
  }
});
/**
 * @route   POST /api/messages/chat/create
 * @desc    Create a new chat between two users
 * @access  Private
 */
router.post("/chat/create", auth, [
  body("receiverId").isMongoId().withMessage("Invalid receiver ID"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array(),
      });
    }

    const { receiverId } = req.body;
    const senderId = req.user._id;

    // Check if receiver exists
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: "Receiver not found"
      });
    }

    // Check if chat already exists using participantsKey
    const sortedParticipants = [senderId, receiverId].map(id => id.toString()).sort();
    const participantsKey = sortedParticipants.join('_');
    
    let chat = await Chat.findOne({ participantsKey });

    if (!chat) {
      try {
        chat = new Chat({
          participants: [senderId, receiverId],
          isActive: true
        });
        await chat.save();
      } catch (error) {
        // If there's a duplicate key error, try to find the existing chat
        if (error.code === 11000) {
          chat = await Chat.findOne({ participantsKey });
        } else {
          throw error;
        }
      }
    }

    // Populate chat with participant details
    await chat.populate("participants", "username avatar isOnline lastSeen");

    const otherParticipant = chat.participants.find(
      (p) => p._id.toString() !== senderId.toString()
    );

    if (!otherParticipant) {
      return res.status(500).json({
        success: false,
        message: "Error finding chat participant"
      });
    }

    const formattedChat = {
      _id: chat._id,
      chatId: chat._id,
      user: {
        id: otherParticipant._id,
        username: otherParticipant.username,
        avatar: otherParticipant.avatar,
        isOnline: otherParticipant.isOnline,
        lastSeen: otherParticipant.lastSeen,
      },
      lastMessage: null,
      unread: 0,
    };

    res.status(201).json({
      success: true,
      message: "Chat created successfully",
      chat: formattedChat
    });

  } catch (error) {
    console.error("Create chat error:", error);
    console.error("Error details:", {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: "Server error while creating chat"
    });
  }
});

/**
 * @route   POST /api/messages/chats/cleanup
 * @desc    Clean up orphaned chats and merge duplicates
 * @access  Private (Admin only - you can add admin check later)
 */
router.post("/chats/cleanup", auth, async (req, res) => {
  try {
    // Find all chats
    const allChats = await Chat.find({ isActive: true })
      .populate("participants", "_id")
      .populate("lastMessage");

    const orphanedChatIds = [];
    const duplicateChats = new Map(); // Map of participantsKey -> array of chat IDs
    
    for (const chat of allChats) {
      // Check if any participant is null (deleted user)
      const hasNullParticipant = chat.participants.some(p => p === null);
      
      if (hasNullParticipant) {
        orphanedChatIds.push(chat._id);
        continue;
      }

      // Check for duplicates using participantsKey
      const participantsKey = chat.participantsKey;
      if (!duplicateChats.has(participantsKey)) {
        duplicateChats.set(participantsKey, []);
      }
      duplicateChats.get(participantsKey).push(chat);
    }

    let mergedChats = 0;
    const chatsToDeactivate = [...orphanedChatIds];

    // Merge duplicate chats
    for (const [participantsKey, chats] of duplicateChats) {
      if (chats.length > 1) {
        // Sort by lastMessageAt to find the most recent chat
        chats.sort((a, b) => {
          const aTime = a.lastMessageAt || a.createdAt || 0;
          const bTime = b.lastMessageAt || b.createdAt || 0;
          return bTime - aTime;
        });

        const keepChat = chats[0]; // Keep the most recent chat
        const duplicateChatIds = chats.slice(1).map(chat => chat._id);
        
        // Move all messages from duplicate chats to the main chat
        await Message.updateMany(
          { chatId: { $in: duplicateChatIds } },
          { chatId: keepChat._id }
        );

        // Deactivate duplicate chats
        chatsToDeactivate.push(...duplicateChatIds);
        mergedChats += chats.length - 1;
      }
    }

    if (chatsToDeactivate.length > 0) {
      // Deactivate orphaned and duplicate chats
      await Chat.updateMany(
        { _id: { $in: chatsToDeactivate } },
        { isActive: false }
      );
    }

    res.json({
      success: true,
      message: `Cleaned up ${orphanedChatIds.length} orphaned chats and merged ${mergedChats} duplicate chats`,
      orphanedChats: orphanedChatIds.length,
      mergedChats: mergedChats,
      totalCleaned: chatsToDeactivate.length
    });
  } catch (error) {
    console.error("Cleanup chats error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while cleaning up chats"
    });
  }
});

module.exports = router;