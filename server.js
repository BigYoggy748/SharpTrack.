const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Trust proxy settings (required for accurate client IP detection behind Netlify/Render proxies)
app.set('trust proxy', 1);

// Disable x-powered-by header
app.disable('x-powered-by');

// Custom HTTP Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self' https:; img-src 'self' data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https:;");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    next();
});

// Security & parsing middleware
const allowedOrigins = [
    'https://sharptrack.space',
    'https://sharptrack.vercel.app',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000'
];
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin without emitting a wildcard CORS header
        if (!origin) {
            return callback(null, false);
        }
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiters configuration
const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5,
    message: { error: 'Too many requests. Please try again in a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 3,
    message: { error: 'Too many OTP requests. Please try again in a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const aiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20,
    message: { error: 'Too many requests. Please try again in a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const productCreateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    message: { error: 'Too many products created. Please try again in a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiters to matching routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/google', authLimiter);
app.use('/api/auth/register-email', authLimiter);
app.use('/api/auth/login-email', authLimiter);
app.use('/api/otp/send', otpLimiter);
app.use('/api/otp/send-email', otpLimiter);
app.use('/api/otp/verify', otpLimiter);
app.use('/api/otp/verify-email', otpLimiter);
app.use('/api/ai/', aiLimiter);
app.use('/api/chat', aiLimiter);
app.use('/api/products', (req, res, next) => {
    if (req.method === 'POST') {
        return productCreateLimiter(req, res, next);
    }
    next();
});

const jwt = require('jsonwebtoken');

// Admin static pages: Authentication is handled client-side by script.js
// which calls /api/admin/me on load and redirects to login if unauthorized.
// All API endpoints are protected by the adminAuth middleware.

// Serve admin login HTML on /admin/login
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

// Admin login rate limiting (max 5 requests per 15 minutes per IP)
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, 
    message: { error: 'Too many login attempts from this IP. Please try again in 15 minutes.' },
    standardHeaders: true, 
    legacyHeaders: false, 
});

// Apply rate limiter to admin login endpoint
app.use('/api/admin/login', adminLoginLimiter);

// API Routes
const adminRoutes = require('./adminRoutes');
app.use('/api/admin', adminRoutes);

const authRoutes = require('./auth');
app.use('/api/auth', authRoutes);

const productRoutes = require('./products');
app.use('/api/products', productRoutes);

const salesRoutes = require('./sales');
app.use('/api/sales', salesRoutes);

const otpRoutes = require('./otp');
app.use('/api/otp', otpRoutes);

const notificationRoutes = require('./notifications');
app.use('/api/notifications', notificationRoutes);

const activityRoutes = require('./activity');
app.use('/api/activity', activityRoutes);

const feedbackRoutes = require('./feedbackRoutes');
app.use('/api/feedback', feedbackRoutes);

const aiRoutes = require('./aiRoutes');
app.use('/api/ai', aiRoutes);
app.get('/test-ai', aiRoutes.testAi);
app.post('/api/scan-product', aiRoutes.scanProduct);

const chatbotRoutes = require('./chatbot');
app.use('/api/chat', chatbotRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'SharpTrack API is running', timestamp: new Date().toISOString() });
});

// Lightweight production-safe health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime())
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
});

const { initCron } = require('./services/cron');
initCron();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SharpTrack server running on port ${PORT}`);
    console.log(`API: http://localhost:${PORT}/api/health`);
    console.log(`App: http://localhost:${PORT}`);
});