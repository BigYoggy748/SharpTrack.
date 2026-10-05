const express = require('express');
const router = express.Router();
const prisma = require('./lib/prisma');
const authMiddleware = require('./middleware/auth');
const { cache, clearCache } = require('./middleware/cache');
const { isValidId } = require('./lib/validation');
const { createNotification } = require('./lib/monitoring');

// RECORD A SALE
router.post('/', authMiddleware, async (req, res) => {
    const { productId, quantitySold, paymentMethod } = req.body;

    if (!productId || !quantitySold) {
        return res.status(400).json({ error: 'Product and quantity are required' });
    }

    if (!isValidId(productId)) {
        return res.status(400).json({ error: 'Invalid product ID format' });
    }

    const qtyToSold = parseInt(quantitySold);
    if (isNaN(qtyToSold) || qtyToSold <= 0) {
        return res.status(400).json({ error: 'Quantity must be at least 1' });
    }

    try {
        // Double-click / Spam prevention: Check if identical sale recorded in last 5 seconds
        const recentSale = await prisma.sale.findFirst({
            where: {
                userId: req.userId,
                productId,
                quantitySold: qtyToSold,
                soldAt: { gte: new Date(Date.now() - 5000) }
            }
        });
        if (recentSale) {
            return res.status(409).json({ error: 'Duplicate sale detected. Please wait a moment.' });
        }

        // Perform stock validation and record sale atomically within a transaction
        
        await tidb.initTable();
        const product = await tidb.getProductById(productId);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        if (product.userId !== req.userId) {
            return res.status(403).json({ error: 'Access forbidden' });
        }
        if (product.quantity < qtyToSold) {
            return res.status(400).json({ error: 'Insufficient stock available' });
        }

        const totalAmount = product.sellingPrice * qtyToSold;

        // Update in TiDB
        const newQuantity = product.quantity - qtyToSold;
        await tidb.updateProduct(productId, { quantity: newQuantity });

        // Create Sale in Prisma
        const sale = await prisma.sale.create({
            data: {
                productId,
                quantitySold: qtyToSold,
                totalAmount,
                paymentMethod: paymentMethod || 'cash',
                userId: req.userId,
                productName: product.name,
                unitPrice: product.sellingPrice
            }
        });

        const productName = product.name;
        const reorderLevel = product.reorderLevel;
        const unit = product.unit;


        // Check for low stock and create notification
        if (newQuantity <= reorderLevel && newQuantity > 0) {
            try {
                await prisma.notification.create({
                    data: {
                        userId: req.userId,
                        type: 'WARNING',
                        title: 'Low Stock Alert',
                        message: `${productName} is running low (${newQuantity} ${unit} remaining). Consider restocking soon.`
                    }
                });
            } catch (e) { /* non-critical */ }
        }

        if (newQuantity === 0) {
            try {
                await prisma.notification.create({
                    data: {
                        userId: req.userId,
                        type: 'SYSTEM',
                        title: 'Out of Stock!',
                        message: `${productName} is now out of stock. Restock immediately to avoid missed sales.`
                    }
                });
            } catch (e) { /* non-critical */ }
        }

        // Create transaction notification
        await createNotification(req.userId, 'info', 'Sale Recorded', `Sold ${sale.quantitySold}x ${productName} for ₦${sale.totalAmount.toLocaleString()}.`);

        res.status(201).json({ message: 'Sale recorded', sale });
    } catch (err) {
        if (err.message === 'NOT_FOUND') {
            return res.status(404).json({ error: 'Product not found' });
        }
        if (err.message === 'FORBIDDEN') {
            return res.status(403).json({ error: 'Access denied' });
        }
        if (err.message === 'OUT_OF_STOCK') {
            return res.status(400).json({ error: 'Not enough stock available.' });
        }
        console.error('Record sale error:', err.message);
        res.status(500).json({ error: 'Failed to record sale' });
    }
});


function formatSales(sales) {
    return sales.map(s => {
        if (!s.productId) {
            s.product = {
                id: s.productId,
                name: s.productName || 'Unknown Product',
                sellingPrice: s.unitPrice || 0,
                unit: 'pieces'
            };
        }
        return s;
    });
}
// GET ALL SALES
router.get('/', authMiddleware, cache('sales'), async (req, res) => {
    try {
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId },
            
            orderBy: { soldAt: 'desc' }
        });
        res.json({ sales: formatSales(sales) });
    } catch (err) {
        console.error('Get all sales error:', err.message);
        res.status(500).json({ error: 'Failed to load sales history' });
    }
});

// GET TODAY'S SALES
router.get('/today', authMiddleware, cache('sales_today'), async (req, res) => {
    let timezoneOffset = -60; // Default to Nigeria (UTC+1)
    if (req.query.timezoneOffset !== undefined) {
        timezoneOffset = parseInt(req.query.timezoneOffset);
    }
    const now = new Date();
    const localNow = new Date(now.getTime() - (timezoneOffset * 60 * 1000));
    localNow.setUTCHours(0, 0, 0, 0);
    const start = new Date(localNow.getTime() + (timezoneOffset * 60 * 1000));

    try {
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId, soldAt: { gte: start } },
            
            orderBy: { soldAt: 'desc' }
        });

        const total = sales.reduce((sum, s) => sum + s.totalAmount, 0);

        // Calculate yesterday's total for comparison
        const yesterdayStart = new Date(start);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        const yesterdaySales = await prisma.sale.findMany({
            where: { 
                userId: req.userId, 
                soldAt: { gte: yesterdayStart, lt: start } 
            }
        });
        const yesterdayTotal = yesterdaySales.reduce((sum, s) => sum + s.totalAmount, 0);

        let percentChange = 0;
        if (yesterdayTotal > 0) {
            percentChange = Math.round(((total - yesterdayTotal) / yesterdayTotal) * 100);
        }

        res.json({ sales, total, yesterdayTotal, percentChange, salesCount: sales.length });
    } catch (err) {
        console.error('Get today sales error:', err.message);
        res.status(500).json({ error: 'Failed to load sales data' });
    }
});

// GET LAST 5 SALES
router.get('/recent', authMiddleware, cache('sales_recent'), async (req, res) => {
    try {
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId },
            
            orderBy: { soldAt: 'desc' },
            take: 5
        });
        res.json({ sales: formatSales(sales) });
    } catch (err) {
        console.error('Get recent sales error:', err.message);
        res.status(500).json({ error: 'Failed to load recent sales' });
    }
});

// GET SALES STATS
router.get('/stats', authMiddleware, cache('sales_stats'), async (req, res) => {
    let timezoneOffset = -60; // Default to Nigeria (UTC+1)
    if (req.query.timezoneOffset !== undefined) {
        timezoneOffset = parseInt(req.query.timezoneOffset);
    }
    const now = new Date();
    const localNow = new Date(now.getTime() - (timezoneOffset * 60 * 1000));
    localNow.setUTCHours(0, 0, 0, 0);
    const today = new Date(localNow.getTime() + (timezoneOffset * 60 * 1000));

    try {
        const todaySales = await prisma.sale.findMany({
            where: { userId: req.userId, soldAt: { gte: today } }
        });

        const allSales = await prisma.sale.findMany({
            where: { userId: req.userId }
        });

        const todayTotal = todaySales.reduce((sum, s) => sum + s.totalAmount, 0);
        const allTimeTotal = allSales.reduce((sum, s) => sum + s.totalAmount, 0);

        res.json({
            todayTotal,
            todaySalesCount: todaySales.length,
            allTimeTotal,
            allTimeSalesCount: allSales.length
        });
    } catch (err) {
        console.error('Get sales stats error:', err.message);
        res.status(500).json({ error: 'Failed to load sales stats' });
    }
});

// GET WEEKLY SALES (Last 7 Days)
router.get('/weekly', authMiddleware, cache('sales_weekly'), async (req, res) => {
    let timezoneOffset = -60; // Default to Nigeria (UTC+1)
    if (req.query.timezoneOffset !== undefined) {
        timezoneOffset = parseInt(req.query.timezoneOffset);
    }
    const now = new Date();
    const localNow = new Date(now.getTime() - (timezoneOffset * 60 * 1000));
    localNow.setUTCHours(0, 0, 0, 0);
    
    // 7 days including today starts at: localNow - 6 days
    const start = new Date(localNow.getTime() - (6 * 24 * 60 * 60 * 1000) + (timezoneOffset * 60 * 1000));

    try {
        const sales = await prisma.sale.findMany({
            where: {
                userId: req.userId,
                soldAt: { gte: start }
            },
            orderBy: { soldAt: 'asc' }
        });

        // Initialize last 7 days mapping
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const weeklyData = [];
        
        for (let i = 6; i >= 0; i--) {
            const d = new Date(localNow.getTime() - (i * 24 * 60 * 60 * 1000));
            const dateStr = d.toISOString().split('T')[0];
            weeklyData.push({
                dayName: days[d.getUTCDay()],
                dateString: dateStr,
                amount: 0,
                count: 0
            });
        }

        // Helper to convert date to local date string
        const getLocalDateString = (date, offset) => {
            const localTime = new Date(date.getTime() - (offset * 60 * 1000));
            return localTime.toISOString().split('T')[0];
        };

        // Aggregate sales by date
        sales.forEach(sale => {
            const saleDate = getLocalDateString(sale.soldAt, timezoneOffset);
            const target = weeklyData.find(item => item.dateString === saleDate);
            if (target) {
                target.amount += sale.totalAmount;
                target.count += 1;
            }
        });

        res.json({ weekly: weeklyData });
// GET ALL SALES
router.get('/', authMiddleware, cache('sales'), async (req, res) => {
    try {
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId },
            
            orderBy: { soldAt: 'desc' }
        });
        res.json({ sales: formatSales(sales) });
    } catch (err) {
        console.error('Get all sales error:', err.message);
        res.status(500).json({ error: 'Failed to load sales history' });
    }
});

// GET TODAY'S SALES
router.get('/today', authMiddleware, cache('sales_today'), async (req, res) => {
    let timezoneOffset = -60; // Default to Nigeria (UTC+1)
    if (req.query.timezoneOffset !== undefined) {
        timezoneOffset = parseInt(req.query.timezoneOffset);
    }
    const now = new Date();
    const localNow = new Date(now.getTime() - (timezoneOffset * 60 * 1000));
    localNow.setUTCHours(0, 0, 0, 0);
    const start = new Date(localNow.getTime() + (timezoneOffset * 60 * 1000));

    try {
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId, soldAt: { gte: start } },
            
            orderBy: { soldAt: 'desc' }
        });

        const total = sales.reduce((sum, s) => sum + s.totalAmount, 0);

        // Calculate yesterday's total for comparison
        const yesterdayStart = new Date(start);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        const yesterdaySales = await prisma.sale.findMany({
            where: { 
                userId: req.userId, 
                soldAt: { gte: yesterdayStart, lt: start } 
            }
        });
        const yesterdayTotal = yesterdaySales.reduce((sum, s) => sum + s.totalAmount, 0);

        let percentChange = 0;
        if (yesterdayTotal > 0) {
            percentChange = Math.round(((total - yesterdayTotal) / yesterdayTotal) * 100);
        }

        res.json({ sales, total, yesterdayTotal, percentChange, salesCount: sales.length });
    } catch (err) {
        console.error('Get today sales error:', err.message);
        res.status(500).json({ error: 'Failed to load sales data' });
    }
});

// GET LAST 5 SALES
router.get('/recent', authMiddleware, cache('sales_recent'), async (req, res) => {
    try {
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId },
            
            orderBy: { soldAt: 'desc' },
            take: 5
        });
        res.json({ sales: formatSales(sales) });
    } catch (err) {
        console.error('Get recent sales error:', err.message);
        res.status(500).json({ error: 'Failed to load recent sales' });
    }
});

// GET SALES STATS
router.get('/stats', authMiddleware, cache('sales_stats'), async (req, res) => {
    let timezoneOffset = -60; // Default to Nigeria (UTC+1)
    if (req.query.timezoneOffset !== undefined) {
        timezoneOffset = parseInt(req.query.timezoneOffset);
    }
    const now = new Date();
    const localNow = new Date(now.getTime() - (timezoneOffset * 60 * 1000));
    localNow.setUTCHours(0, 0, 0, 0);
    const today = new Date(localNow.getTime() + (timezoneOffset * 60 * 1000));

    try {
        const todaySales = await prisma.sale.findMany({
            where: { userId: req.userId, soldAt: { gte: today } }
        });

        const allSales = await prisma.sale.findMany({
            where: { userId: req.userId }
        });

        const todayTotal = todaySales.reduce((sum, s) => sum + s.totalAmount, 0);
        const allTimeTotal = allSales.reduce((sum, s) => sum + s.totalAmount, 0);

        res.json({
            todayTotal,
            todaySalesCount: todaySales.length,
            allTimeTotal,
            allTimeSalesCount: allSales.length
        });
    } catch (err) {
        console.error('Get sales stats error:', err.message);
        res.status(500).json({ error: 'Failed to load sales stats' });
    }
});

// GET WEEKLY SALES (Last 7 Days)
router.get('/weekly', authMiddleware, cache('sales_weekly'), async (req, res) => {
    let timezoneOffset = -60; // Default to Nigeria (UTC+1)
    if (req.query.timezoneOffset !== undefined) {
        timezoneOffset = parseInt(req.query.timezoneOffset);
    }
    const now = new Date();
    const localNow = new Date(now.getTime() - (timezoneOffset * 60 * 1000));
    localNow.setUTCHours(0, 0, 0, 0);
    
    // 7 days including today starts at: localNow - 6 days
    const start = new Date(localNow.getTime() - (6 * 24 * 60 * 60 * 1000) + (timezoneOffset * 60 * 1000));

    try {
        const sales = await prisma.sale.findMany({
            where: {
                userId: req.userId,
                soldAt: { gte: start }
            },
            orderBy: { soldAt: 'asc' }
        });

        // Initialize last 7 days mapping
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const weeklyData = [];
        
        for (let i = 6; i >= 0; i--) {
            const d = new Date(localNow.getTime() - (i * 24 * 60 * 60 * 1000));
            const dateStr = d.toISOString().split('T')[0];
            weeklyData.push({
                dayName: days[d.getUTCDay()],
                dateString: dateStr,
                amount: 0,
                count: 0
            });
        }

        // Helper to convert date to local date string
        const getLocalDateString = (date, offset) => {
            const localTime = new Date(date.getTime() - (offset * 60 * 1000));
            return localTime.toISOString().split('T')[0];
        };

        // Aggregate sales by date
        sales.forEach(sale => {
            const saleDate = getLocalDateString(sale.soldAt, timezoneOffset);
            const target = weeklyData.find(item => item.dateString === saleDate);
            if (target) {
                target.amount += sale.totalAmount;
                target.count += 1;
            }
        });

        res.json({ weekly: weeklyData });
    } catch (err) {
        console.error('Get weekly sales error:', err.message);
        res.status(500).json({ error: 'Failed to load weekly sales' });
    }
});

// GET TOP-SELLING PRODUCTS
router.get('/top-products', authMiddleware, cache('sales_top'), async (req, res) => {
    try {
        // Fetch all sales for this user
        const sales = await prisma.sale.findMany({
            where: { userId: req.userId },
            orderBy: { soldAt: 'asc' }
        });

        // Group sales by productId
        const productMap = new Map();
        sales.forEach(sale => {
            if (!productMap.has(sale.productId)) {
                productMap.set(sale.productId, {
                    productId: sale.productId,
                    name: sale.productName || 'Unknown Product',
                    quantity: 0,
                    revenue: 0
                });
            }
            
            const prodStats = productMap.get(sale.productId);
            prodStats.quantity += sale.quantitySold;
            prodStats.revenue += sale.totalAmount;
        });

        // Fetch user products to get images and units
        let products = [];
        try {
            products = await tidb.getProductsByUser(req.userId);
        } catch (e) {
            console.error("Could not fetch products from tidb for top-products", e.message);
        }

        // Convert map to array and merge with product details
        const topProductsRaw = Array.from(productMap.values()).map(p => {
            const prod = products.find(prod => prod.id === p.productId);
            return {
                ...p,
                image: prod ? prod.image : null,
                unit: prod ? prod.unit : 'pcs'
            };
        });

        // Sort by highest revenue
        const topProducts = topProductsRaw
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 10);

        res.json({ topProducts });
    } catch (err) {
        console.error('Get top products error:', err.message);
        res.status(500).json({ error: 'Failed to load top products' });
    }
});

module.exports = router;