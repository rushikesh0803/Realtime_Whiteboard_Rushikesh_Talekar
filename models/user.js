import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, unique: true, sparse: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  color: { type: String, default: '#7c3aed' }
}, { timestamps: true });

export default mongoose.model('User', userSchema);
