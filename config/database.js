const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Attempt to drop legacy unique index on participants array (if it exists).
    // That index prevents any user from being in more than one chat.
    try {
      const collection = conn.connection.db.collection('chats');
      await collection.dropIndex('participants_1');
      console.log('Dropped legacy index participants_1 on chats');
    } catch (idxErr) {
      // Ignore if index doesn't exist
      if (idxErr && !/index not found/i.test(idxErr.message)) {
        console.warn('Could not drop legacy participants_1 index:', idxErr.message);
      }
    }
  } catch (error) {
    console.error('Database connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;