const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  // A stable, unique key for the pair of participants (sorted ids joined by '_')
  participantsKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Ensure only 2 participants per chat and compute participantsKey
// IMPORTANT: run before validation so required fields pass
chatSchema.pre('validate', function(next) {
  if (!Array.isArray(this.participants) || this.participants.length !== 2) {
    return next(new Error('Chat must have exactly 2 participants'));
  }
  
  // Convert ObjectIds to strings and sort them
  const sorted = this.participants.map(p => p.toString()).sort();
  this.participants = sorted;
  this.participantsKey = sorted.join('_');
  next();
});

// Note: We intentionally DO NOT keep a unique index on the array field `participants`
// because MongoDB would enforce uniqueness per element, preventing a user from
// participating in multiple chats. We rely on `participantsKey` for pair-uniqueness.

// Virtual for chat ID
chatSchema.virtual('chatId').get(function() {
  const sortedParticipants = this.participants.map(p => p.toString()).sort();
  return sortedParticipants.join('_');
});

module.exports = mongoose.model('Chat', chatSchema);