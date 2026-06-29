const { connect } = require('@tidbcloud/serverless');

const tidbUrl = process.env.TIDB_DATABASE_URL;

// Ensure connection is cached or created properly
let _conn = null;
function getConnection() {
    if (!tidbUrl) {
        console.warn("WARNING: TIDB_DATABASE_URL is not set in environment variables!");
        return null;
    }
    if (!_conn) {
        _conn = connect({ url: tidbUrl });
    }
    return _conn;
}

// Utility to convert row results if needed
function parseRow(row) {
    if (!row) return row;
    return {
        ...row,
        sellingPrice: parseFloat(row.sellingPrice) || 0,
        costPrice: row.costPrice ? parseFloat(row.costPrice) : null,
        quantity: parseInt(row.quantity, 10) || 0,
        reorderLevel: parseInt(row.reorderLevel, 10) || 0
    };
}

// Track initialization to ensure table exists
let isInitialized = false;

module.exports = {
    // Basic setup if table doesn't exist
    initTable: async () => {
        if (isInitialized) return;
        const conn = getConnection();
        if (!conn) return;
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS Product (
                id VARCHAR(191) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                sellingPrice DECIMAL(10, 2) NOT NULL,
                costPrice DECIMAL(10, 2),
                quantity INT NOT NULL,
                reorderLevel INT DEFAULT 5,
                unit VARCHAR(50) DEFAULT 'pieces',
                userId VARCHAR(191) NOT NULL,
                barcode VARCHAR(191),
                brand VARCHAR(255),
                categoryId VARCHAR(191),
                specifications TEXT,
                weight VARCHAR(50),
                manufacturer VARCHAR(255),
                description TEXT,
                image LONGTEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_userId (userId)
            );
        `);
        isInitialized = true;
    },

    getProductsByUser: async (userId) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return [];
        const result = await conn.execute('SELECT * FROM Product WHERE userId = ? ORDER BY createdAt DESC', [userId]);
        return result.map(parseRow);
    },

    getProductById: async (id) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return null;
        const result = await conn.execute('SELECT * FROM Product WHERE id = ?', [id]);
        return result.length > 0 ? parseRow(result[0]) : null;
    },

    createProduct: async (data) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return null;
        
        // Generate CUID-like ID
        const id = 'c' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        
        await conn.execute(`
            INSERT INTO Product (
                id, name, sellingPrice, costPrice, quantity, reorderLevel, unit, userId, barcode, brand, categoryId, specifications, weight, manufacturer, description, image
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id, data.name, data.sellingPrice, data.costPrice || null, data.quantity, data.reorderLevel || 5, data.unit || 'pieces',
            data.userId, data.barcode || null, data.brand || null, data.categoryId || null, data.specifications || null,
            data.weight || null, data.manufacturer || null, data.description || null, data.image || null
        ]);

        return module.exports.getProductById(id);
    },

    updateProduct: async (id, data) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return null;

        const updates = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            updates.push(`${key} = ?`);
            values.push(value);
        }
        values.push(id);

        if (updates.length > 0) {
            await conn.execute(`UPDATE Product SET ${updates.join(', ')} WHERE id = ?`, values);
        }

        return module.exports.getProductById(id);
    },

    deleteProduct: async (id) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return false;
        await conn.execute('DELETE FROM Product WHERE id = ?', [id]);
        return true;
    },

    searchProducts: async (userId, query) => {
        const conn = getConnection();
        if (!conn) return [];
        const searchPattern = `%${query}%`;
        const result = await conn.execute(
            'SELECT * FROM Product WHERE userId = ? AND (name LIKE ? OR barcode LIKE ? OR brand LIKE ?) ORDER BY createdAt DESC',
            [userId, searchPattern, searchPattern, searchPattern]
        );
        return result.map(parseRow);
    },

    countProductsByUser: async (userId) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return 0;
        const result = await conn.execute('SELECT COUNT(*) as count FROM Product WHERE userId = ?', [userId]);
        return parseInt(result[0].count, 10);
    },

    countAllProducts: async () => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return 0;
        const result = await conn.execute('SELECT COUNT(*) as count FROM Product');
        return parseInt(result[0].count, 10);
    },

    deleteProductsByUser: async (userId) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return false;
        await conn.execute('DELETE FROM Product WHERE userId = ?', [userId]);
        return true;
    },

    getAllProductsAdmin: async (page = 1, limit = 50) => {
        await module.exports.initTable();
        const conn = getConnection();
        if (!conn) return [];
        const offset = (page - 1) * limit;
        const result = await conn.execute('SELECT * FROM Product ORDER BY createdAt DESC LIMIT ? OFFSET ?', [limit, offset]);
        return result.map(parseRow);
    }
};
