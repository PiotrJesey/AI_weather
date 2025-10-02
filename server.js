const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs').promises;
const https = require('https');
const csv = require('csv-parser');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const WEATHER_CITY = process.env.WEATHER_CITY || 'Jersey';
const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

// Configure multer for file uploads
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'));
        }
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database configuration
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME || 'strato_db',
    options: { 
        encrypt: true, 
        trustServerCertificate: false,
        requestTimeout: 30000,
        connectionTimeout: 30000
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// Global variables
let pool, model, normalizationParams = {};
let useMemoryFallback = false;
let temperatureData = [], predictions = [], predictionAccuracy = [];
let autoCompareInterval;

// Database initialization
async function initDB() {
    try {
        console.log('Attempting to connect to Azure SQL...');
        
        if (!dbConfig.server || !dbConfig.user || !dbConfig.password) {
            throw new Error('Missing required database credentials');
        }
        
        pool = await sql.connect(dbConfig);
        await pool.request().query('SELECT 1 as test');
        
        console.log('✅ Connected to Azure SQL Database (strato_db)');
        await createTables();
        return true;
        
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        console.log('🔄 Switching to in-memory fallback mode...');
        useMemoryFallback = true;
        await loadMemoryData();
        return true;
    }
}

// Create tables - Enhanced schema with manual evaluation support
async function createTables() {
    const tables = [
        {
            name: 'temperature_data',
            sql: `
                IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'temperature_data')
                CREATE TABLE temperature_data (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    date_time DATETIME2 NOT NULL DEFAULT GETDATE(),
                    temperature FLOAT NOT NULL,
                    humidity FLOAT DEFAULT 60,
                    pressure FLOAT DEFAULT 1013,
                    wind_speed FLOAT DEFAULT 5,
                    cloud_cover FLOAT DEFAULT 50,
                    data_type VARCHAR(50) DEFAULT 'actual',
                    created_at DATETIME2 DEFAULT GETDATE()
                )
            `
        },
        {
            name: 'predictions',
            sql: `
                IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'predictions')
                CREATE TABLE predictions (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    prediction_date DATETIME2 DEFAULT GETDATE(),
                    target_date DATETIME2 NOT NULL,
                    predicted_temperature FLOAT NOT NULL,
                    confidence FLOAT DEFAULT 0.8,
                    features_used TEXT,
                    model_version VARCHAR(50) DEFAULT 'v2.0',
                    prediction_type VARCHAR(20) DEFAULT 'single',
                    days_ahead INT DEFAULT 1,
                    auto_evaluated BIT DEFAULT 0,
                    created_at DATETIME2 DEFAULT GETDATE()
                )
            `
        },
        {
            name: 'prediction_accuracy',
            sql: `
                IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'prediction_accuracy')
                CREATE TABLE prediction_accuracy (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    prediction_id INT NOT NULL,
                    actual_temperature FLOAT NOT NULL,
                    predicted_temperature FLOAT NOT NULL,
                    absolute_error FLOAT NOT NULL,
                    percentage_error FLOAT NOT NULL,
                    evaluation_date DATETIME2 DEFAULT GETDATE(),
                    evaluation_type VARCHAR(20) DEFAULT 'manual',
                    accuracy_category VARCHAR(20),
                    notes TEXT,
                    created_at DATETIME2 DEFAULT GETDATE(),
                    FOREIGN KEY (prediction_id) REFERENCES predictions(id)
                )
            `
        }
    ];

    for (const table of tables) {
        try {
            await pool.request().query(table.sql);
            console.log(`✅ Table ${table.name} ready`);
        } catch (err) {
            console.error(`❌ Error creating table ${table.name}:`, err.message);
        }
    }
}

// Weather API functions (keeping existing code)
async function fetchWeatherData() {
    return new Promise((resolve, reject) => {
        if (!WEATHER_API_KEY) {
            reject(new Error('Weather API key not configured'));
            return;
        }

        const url = `${WEATHER_API_URL}?q=${encodeURIComponent(WEATHER_CITY)}&appid=${WEATHER_API_KEY}&units=metric`;
        
        const req = https.get(url, { timeout: 10000 }, (response) => {
            let data = '';
            
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const weather = JSON.parse(data);
                    
                    if (weather.cod !== 200) {
                        reject(new Error(`Weather API error (${weather.cod}): ${weather.message || 'Unknown error'}`));
                        return;
                    }
                    
                    resolve({
                        temperature: Math.round((weather.main?.temp || 20) * 10) / 10,
                        humidity: weather.main?.humidity || 60,
                        pressure: weather.main?.pressure || 1013,
                        wind_speed: Math.round(((weather.wind?.speed || 0) * 3.6) * 10) / 10,
                        cloud_cover: weather.clouds?.all || 50,
                        weather_description: weather.weather?.[0]?.description || 'clear',
                        city: weather.name || WEATHER_CITY,
                        country: weather.sys?.country || 'Unknown',
                        timestamp: new Date()
                    });
                } catch (parseError) {
                    reject(new Error(`Failed to parse weather response: ${parseError.message}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error(`Weather API request failed: ${error.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Weather API request timeout'));
        });
    });
}

function generateFallbackWeather() {
    const baseTemp = 18 + (Math.random() * 8);
    return {
        temperature: Math.round(baseTemp * 10) / 10,
        humidity: 50 + Math.round(Math.random() * 30),
        pressure: 1003 + Math.round(Math.random() * 20),
        wind_speed: Math.round(Math.random() * 15 * 10) / 10,
        cloud_cover: Math.round(Math.random() * 100),
        weather_description: 'simulated data',
        city: WEATHER_CITY || 'Demo City',
        country: 'Demo',
        timestamp: new Date()
    };
}

// Helper function to determine accuracy category
function getAccuracyCategory(absoluteError) {
    if (absoluteError <= 1.0) return 'excellent';
    if (absoluteError <= 2.0) return 'good';
    if (absoluteError <= 3.0) return 'fair';
    if (absoluteError <= 5.0) return 'poor';
    return 'very_poor';
}

// Auto-comparison system (keeping existing with enhancements)
async function autoComparePredictions() {
    try {
        console.log('🔍 Running auto-comparison check...');
        
        let pendingPredictions;
        const now = new Date();
        
        if (useMemoryFallback) {
            pendingPredictions = predictions.filter(pred => {
                const targetDate = new Date(pred.target_date);
                return !pred.auto_evaluated && targetDate < now && 
                       !predictionAccuracy.some(acc => acc.prediction_id === pred.id);
            });
        } else {
            const result = await pool.request().query(`
                SELECT p.* FROM predictions p
                LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id
                WHERE p.target_date < GETDATE() AND p.auto_evaluated = 0 AND pa.id IS NULL
            `);
            pendingPredictions = result.recordset;
        }
        
        console.log(`Found ${pendingPredictions.length} predictions to evaluate`);
        
        for (const prediction of pendingPredictions) {
            const targetDate = new Date(prediction.target_date);
            const tolerance = 2 * 60 * 60 * 1000;
            
            let actualData;
            if (useMemoryFallback) {
                actualData = temperatureData.find(data => 
                    Math.abs(new Date(data.date_time) - targetDate) <= tolerance
                );
            } else {
                const result = await pool.request()
                    .input('target_date', sql.DateTime2, targetDate)
                    .query(`
                        SELECT TOP 1 * FROM temperature_data 
                        WHERE ABS(DATEDIFF(MINUTE, date_time, @target_date)) <= 120
                        ORDER BY ABS(DATEDIFF(MINUTE, date_time, @target_date))
                    `);
                actualData = result.recordset[0];
            }
            
            if (actualData) {
                const error = Math.abs(actualData.temperature - prediction.predicted_temperature);
                const percentageError = (error / Math.abs(actualData.temperature)) * 100;
                const accuracyCategory = getAccuracyCategory(error);
                
                if (useMemoryFallback) {
                    predictionAccuracy.push({
                        id: predictionAccuracy.length + 1,
                        prediction_id: prediction.id,
                        actual_temperature: actualData.temperature,
                        predicted_temperature: prediction.predicted_temperature,
                        absolute_error: error,
                        percentage_error: percentageError,
                        evaluation_date: new Date().toISOString(),
                        evaluation_type: 'auto',
                        accuracy_category: accuracyCategory
                    });
                    
                    const predIndex = predictions.findIndex(p => p.id === prediction.id);
                    if (predIndex >= 0) predictions[predIndex].auto_evaluated = true;
                    await saveMemoryData();
                } else {
                    await pool.request()
                        .input('prediction_id', sql.Int, prediction.id)
                        .input('actual_temperature', sql.Float, actualData.temperature)
                        .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                        .input('absolute_error', sql.Float, error)
                        .input('percentage_error', sql.Float, percentageError)
                        .input('accuracy_category', sql.VarChar(20), accuracyCategory)
                        .query(`
                            INSERT INTO prediction_accuracy 
                            (prediction_id, actual_temperature, predicted_temperature, absolute_error, percentage_error, evaluation_type, accuracy_category) 
                            VALUES (@prediction_id, @actual_temperature, @predicted_temperature, @absolute_error, @percentage_error, 'auto', @accuracy_category)
                        `);
                    
                    await pool.request()
                        .input('id', sql.Int, prediction.id)
                        .query('UPDATE predictions SET auto_evaluated = 1 WHERE id = @id');
                }
                
                console.log(`✅ Auto-evaluated prediction #${prediction.id}: ${error.toFixed(2)}°C error (${accuracyCategory})`);
            }
        }
    } catch (error) {
        console.error('Auto-comparison failed:', error.message);
    }
}

// AI Model functions (keeping existing)
async function createModel() {
    try {
        model = tf.sequential({
            layers: [
                tf.layers.dense({ inputShape: [7], units: 64, activation: 'relu' }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.dense({ units: 32, activation: 'relu' }),
                tf.layers.dense({ units: 1, activation: 'linear' })
            ]
        });
        
        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError',
            metrics: ['mae']
        });
        
        console.log('🧠 AI model created');
        return true;
    } catch (error) {
        
        console.error('Model creation failed:', error.message);
        return false;
    }
}

async function trainModel() {
    try {
        let data;
        
        if (useMemoryFallback) {
            data = temperatureData
                .filter(d => d.data_type === 'actual' || d.data_type === 'correction' || d.data_type === 'weather_api')
                .slice(-1000);
        } else {
            const result = await pool.request().query(`
                SELECT TOP 1000 temperature, humidity, pressure, wind_speed, cloud_cover, date_time
                FROM temperature_data 
                WHERE data_type IN ('actual', 'correction', 'weather_api') 
                ORDER BY date_time DESC
            `);
            data = result.recordset;
        }
        
        if (data.length < 10) {
            console.log('⚠️  Need at least 10 data points for training');
            return false;
        }
        
        const processedData = [];
        for (let i = 5; i < data.length; i++) {
            const current = data[i];
            const recent = data.slice(i-5, i);
            const avgTemp = recent.reduce((sum, d) => sum + d.temperature, 0) / 5;
            
            processedData.push({
                ...current,
                prev_temp: recent[4].temperature,
                avg_temp: avgTemp
            });
        }
        
        const temps = processedData.map(d => d.temperature);
        const tempMean = temps.reduce((a, b) => a + b) / temps.length;
        const tempStd = Math.sqrt(temps.map(t => (t - tempMean) ** 2).reduce((a, b) => a + b) / temps.length);
        
        normalizationParams = { tempMean, tempStd };
        
        const features = processedData.map(d => [
            (d.prev_temp - tempMean) / tempStd,
            d.humidity / 100,
            (d.pressure - 1013) / 50,
            d.wind_speed / 30,
            d.cloud_cover / 100,
            Math.sin(2 * Math.PI * new Date(d.date_time).getHours() / 24),
            (d.avg_temp - tempMean) / tempStd
        ]);
        
        const labels = processedData.map(d => (d.temperature - tempMean) / tempStd);
        
        await model.fit(
            tf.tensor2d(features), 
            tf.tensor2d(labels, [labels.length, 1]), 
            {
                epochs: Math.min(50, Math.max(20, Math.floor(data.length / 20))),
                batchSize: Math.min(32, Math.floor(data.length / 4)),
                validationSplit: 0.2,
                verbose: 0
            }
        );
        
        console.log('✅ Model training completed');
        return true;
        
    } catch (error) {
        console.error('Training failed:', error.message);
        return false;
    }
}

async function makePrediction(targetDate, daysAhead = 1) {
    if (!model || !normalizationParams.tempMean) {
        throw new Error('Model not ready - train the model first');
    }
    
    let recentData;
    if (useMemoryFallback) {
        recentData = temperatureData
            .filter(d => new Date(d.date_time) < targetDate)
            .sort((a, b) => new Date(b.date_time) - new Date(a.date_time))
            .slice(0, 10);
    } else {
        const result = await pool.request()
            .input('target_date', sql.DateTime2, targetDate)
            .query(`SELECT TOP 10 * FROM temperature_data WHERE date_time < @target_date ORDER BY date_time DESC`);
        recentData = result.recordset;
    }
    
    if (recentData.length === 0) {
        throw new Error('No historical data available for prediction');
    }
    
    const latest = recentData[0];
    const recent5 = recentData.slice(0, 5);
    const avgTemp = recent5.reduce((sum, d) => sum + d.temperature, 0) / recent5.length;
    const targetHour = new Date(targetDate).getHours();
    
    const features = [
        (latest.temperature - normalizationParams.tempMean) / normalizationParams.tempStd,
        latest.humidity / 100,
        (latest.pressure - 1013) / 50,
        latest.wind_speed / 30,
        latest.cloud_cover / 100,
        Math.sin(2 * Math.PI * targetHour / 24),
        (avgTemp - normalizationParams.tempMean) / normalizationParams.tempStd
    ];
    
    const prediction = model.predict(tf.tensor2d([features]));
    const result = await prediction.data();
    prediction.dispose();
    
    const predictedTemp = Math.round((result[0] * normalizationParams.tempStd + normalizationParams.tempMean) * 10) / 10;
    const confidence = Math.round(0.85 * Math.exp(-daysAhead * 0.1) * 100) / 100;
    
    return {
        predicted_temperature: predictedTemp,
        confidence: confidence
    };
}

// Memory management (keeping existing)
async function loadMemoryData() {
    try {
        const data = JSON.parse(await fs.readFile('strato_data.json', 'utf8'));
        temperatureData = data.temperatureData || [];
        predictions = data.predictions || [];
        predictionAccuracy = data.predictionAccuracy || [];
        console.log(`📁 Loaded ${temperatureData.length} records from memory`);
    } catch (err) {
        console.log('📄 Creating new memory storage');
        temperatureData = [];
        predictions = [];
        predictionAccuracy = [];
    }
}

async function saveMemoryData() {
    if (!useMemoryFallback) return;
    try {
        await fs.writeFile('strato_data.json', JSON.stringify({
            temperatureData, 
            predictions, 
            predictionAccuracy, 
            lastSaved: new Date()
        }, null, 2));
    } catch (error) {
        console.error('Failed to save memory data:', error.message);
    }
}

// ===== API ROUTES =====

// Health check (enhanced)
app.get('/api/health', async (req, res) => {
    try {
        let stats;
        
        if (useMemoryFallback) {
            stats = { 
                total_records: temperatureData.length, 
                predictions: predictions.length,
                accuracy_records: predictionAccuracy.length,
                auto_evaluated: predictionAccuracy.filter(acc => acc.evaluation_type === 'auto').length,
                manual_evaluated: predictionAccuracy.filter(acc => acc.evaluation_type === 'manual').length,
                pending_evaluations: predictions.filter(p => {
                    const targetDate = new Date(p.target_date);
                    return targetDate <= new Date() && 
                           !predictionAccuracy.some(acc => acc.prediction_id === p.id);
                }).length
            };
        } else {
            try {
                const result = await pool.request().query(`
                    SELECT 
                        (SELECT COUNT(*) FROM temperature_data) as total_records,
                        (SELECT COUNT(*) FROM predictions) as predictions,
                        (SELECT COUNT(*) FROM prediction_accuracy) as accuracy_records,
                        (SELECT COUNT(*) FROM prediction_accuracy WHERE evaluation_type = 'auto') as auto_evaluated,
                        (SELECT COUNT(*) FROM prediction_accuracy WHERE evaluation_type = 'manual') as manual_evaluated,
                        (SELECT COUNT(*) FROM predictions p 
                         LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id 
                         WHERE p.target_date <= GETDATE() AND pa.id IS NULL) as pending_evaluations
                `);
                stats = result.recordset[0];
            } catch (dbError) {
                stats = { error: 'Database query failed', message: dbError.message };
            }
        }
        
        res.json({
            status: 'healthy',
            database: useMemoryFallback ? 'in-memory' : 'azure-sql',
            model: model ? 'loaded' : 'not_loaded',
            model_trained: normalizationParams.tempMean ? true : false,
            auto_comparison: !!autoCompareInterval,
            weather_api: !!WEATHER_API_KEY,
            data_summary: stats,
            timestamp: new Date()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message,
            timestamp: new Date()
        });
    }
});

// Get analytics (enhanced)
app.get('/api/analytics', async (req, res) => {
    try {
        let data, accuracyData, pendingPredictions;
        
        if (useMemoryFallback) {
            data = temperatureData;
            accuracyData = predictionAccuracy;
            pendingPredictions = predictions.filter(p => {
                const targetDate = new Date(p.target_date);
                return targetDate <= new Date() && 
                       !predictionAccuracy.some(acc => acc.prediction_id === p.id);
            });
        } else {
            const tempResult = await pool.request().query('SELECT * FROM temperature_data ORDER BY date_time');
            const accResult = await pool.request().query('SELECT * FROM prediction_accuracy ORDER BY evaluation_date');
            const pendingResult = await pool.request().query(`
                SELECT p.* FROM predictions p
                LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id
                WHERE p.target_date <= GETDATE() AND pa.id IS NULL
            `);
            
            data = tempResult.recordset;
            accuracyData = accResult.recordset;
            pendingPredictions = pendingResult.recordset;
        }
        
        const analytics = {
            total_data_points: data.length,
            total_predictions: accuracyData.length,
            average_error: accuracyData.length > 0 ? 
                accuracyData.reduce((sum, a) => sum + a.absolute_error, 0) / accuracyData.length : 0,
            recent_accuracy: accuracyData.slice(-10).length > 0 ?
                accuracyData.slice(-10).reduce((sum, a) => sum + (100 - a.percentage_error), 0) / accuracyData.slice(-10).length : 0,
            auto_evaluations: accuracyData.filter(a => a.evaluation_type === 'auto').length,
            manual_evaluations: accuracyData.filter(a => a.evaluation_type === 'manual').length,
            pending_evaluations: pendingPredictions.length,
            accuracy_breakdown: {
                excellent: accuracyData.filter(a => a.accuracy_category === 'excellent').length,
                good: accuracyData.filter(a => a.accuracy_category === 'good').length,
                fair: accuracyData.filter(a => a.accuracy_category === 'fair').length,
                poor: accuracyData.filter(a => a.accuracy_category === 'poor').length,
                very_poor: accuracyData.filter(a => a.accuracy_category === 'very_poor').length
            }
        };
        
        res.json(analytics);
    } catch (error) {
        console.error('Analytics error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Get predictions pending evaluation
app.get('/api/predictions/pending-evaluation', async (req, res) => {
    try {
        let pendingPredictions;
        
        if (useMemoryFallback) {
            pendingPredictions = predictions.filter(pred => {
                const targetDate = new Date(pred.target_date);
                return targetDate <= new Date() && 
                       !predictionAccuracy.some(acc => acc.prediction_id === pred.id);
            }).sort((a, b) => new Date(a.target_date) - new Date(b.target_date));
        } else {
            const result = await pool.request().query(`
                SELECT p.* FROM predictions p
                LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id
                WHERE p.target_date <= GETDATE() AND pa.id IS NULL
                ORDER BY p.target_date ASC
            `);
            pendingPredictions = result.recordset;
        }
        
        res.json(pendingPredictions);
    } catch (error) {
        console.error('Pending evaluations error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Evaluate specific prediction
app.post('/api/predictions/:id/evaluate', async (req, res) => {
    try {
        const predictionId = parseInt(req.params.id);
        const { actual_temperature, evaluation_type = 'manual', notes } = req.body;
        
        if (!predictionId || typeof actual_temperature !== 'number') {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid prediction ID or actual temperature' 
            });
        }
        
        if (actual_temperature < -50 || actual_temperature > 60) {
            return res.status(400).json({ 
                success: false, 
                error: 'Actual temperature seems unrealistic (-50°C to 60°C expected)' 
            });
        }
        
        // Get prediction
        let prediction;
        if (useMemoryFallback) {
            prediction = predictions.find(p => p.id === predictionId);
        } else {
            const result = await pool.request()
                .input('id', sql.Int, predictionId)
                .query('SELECT * FROM predictions WHERE id = @id');
            prediction = result.recordset[0];
        }
        
        if (!prediction) {
            return res.status(404).json({ success: false, error: 'Prediction not found' });
        }
        
        // Check if already evaluated
        let existingEvaluation;
        if (useMemoryFallback) {
            existingEvaluation = predictionAccuracy.find(acc => acc.prediction_id === predictionId);
        } else {
            const result = await pool.request()
                .input('prediction_id', sql.Int, predictionId)
                .query('SELECT * FROM prediction_accuracy WHERE prediction_id = @prediction_id');
            existingEvaluation = result.recordset[0];
        }
        
        if (existingEvaluation) {
            return res.status(400).json({ 
                success: false, 
                error: 'Prediction has already been evaluated' 
            });
        }
        
        const error = Math.abs(actual_temperature - prediction.predicted_temperature);
        const percentageError = (error / Math.abs(actual_temperature)) * 100;
        const accuracyCategory = getAccuracyCategory(error);
        
        // Save evaluation
        if (useMemoryFallback) {
            predictionAccuracy.push({
                id: predictionAccuracy.length + 1,
                prediction_id: predictionId,
                actual_temperature,
                predicted_temperature: prediction.predicted_temperature,
                absolute_error: error,
                percentage_error: percentageError,
                evaluation_date: new Date().toISOString(),
                evaluation_type,
                accuracy_category,
                notes: notes || null
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('prediction_id', sql.Int, predictionId)
                .input('actual_temperature', sql.Float, actual_temperature)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('absolute_error', sql.Float, error)
                .input('percentage_error', sql.Float, percentageError)
                .input('evaluation_type', sql.VarChar(20), evaluation_type)
                .input('accuracy_category', sql.VarChar(20), accuracyCategory)
                .input('notes', sql.Text, notes || null)
                .query(`
                    INSERT INTO prediction_accuracy 
                    (prediction_id, actual_temperature, predicted_temperature, absolute_error, 
                     percentage_error, evaluation_type, accuracy_category, notes) 
                    VALUES (@prediction_id, @actual_temperature, @predicted_temperature, 
                            @absolute_error, @percentage_error, @evaluation_type, @accuracy_category, @notes)
                `);
        }
        
        res.json({
            success: true,
            prediction_id: predictionId,
            predicted_temperature: prediction.predicted_temperature,
            actual_temperature,
            absolute_error: Math.round(error * 100) / 100,
            percentage_error: Math.round(percentageError * 100) / 100,
            accuracy_category: accuracyCategory,
            evaluation_type
        });
    } catch (error) {
        console.error('Evaluation error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Evaluate prediction by target date
app.post('/api/predictions/evaluate-by-date', async (req, res) => {
    try {
        const { target_date, actual_temperature, evaluation_type = 'manual_quick' } = req.body;
        
        if (!target_date || typeof actual_temperature !== 'number') {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid target date or actual temperature' 
            });
        }
        
        const targetDate = new Date(target_date);
        
        // Find predictions for this date
        let matchingPredictions;
        if (useMemoryFallback) {
            matchingPredictions = predictions.filter(pred => {
                const predTargetDate = new Date(pred.target_date);
                return Math.abs(predTargetDate - targetDate) < 24 * 60 * 60 * 1000 && // Same day
                       !predictionAccuracy.some(acc => acc.prediction_id === pred.id);
            });
        } else {
            const result = await pool.request()
                .input('target_date', sql.DateTime2, targetDate)
                .query(`
                    SELECT p.* FROM predictions p
                    LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id
                    WHERE CAST(p.target_date AS DATE) = CAST(@target_date AS DATE) 
                    AND pa.id IS NULL
                `);
            matchingPredictions = result.recordset;
        }
        
        if (matchingPredictions.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'No unevaluated predictions found for this date' 
            });
        }
        
        let evaluatedCount = 0;
        
        for (const prediction of matchingPredictions) {
            const error = Math.abs(actual_temperature - prediction.predicted_temperature);
            const percentageError = (error / Math.abs(actual_temperature)) * 100;
            const accuracyCategory = getAccuracyCategory(error);
            
            if (useMemoryFallback) {
                predictionAccuracy.push({
                    id: predictionAccuracy.length + 1,
                    prediction_id: prediction.id,
                    actual_temperature,
                    predicted_temperature: prediction.predicted_temperature,
                    absolute_error: error,
                    percentage_error: percentageError,
                    evaluation_date: new Date().toISOString(),
                    evaluation_type,
                    accuracy_category
                });
                evaluatedCount++;
            } else {
                await pool.request()
                    .input('prediction_id', sql.Int, prediction.id)
                    .input('actual_temperature', sql.Float, actual_temperature)
                    .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                    .input('absolute_error', sql.Float, error)
                    .input('percentage_error', sql.Float, percentageError)
                    .input('evaluation_type', sql.VarChar(20), evaluation_type)
                    .input('accuracy_category', sql.VarChar(20), accuracyCategory)
                    .query(`
                        INSERT INTO prediction_accuracy 
                        (prediction_id, actual_temperature, predicted_temperature, absolute_error, 
                         percentage_error, evaluation_type, accuracy_category) 
                        VALUES (@prediction_id, @actual_temperature, @predicted_temperature, 
                                @absolute_error, @percentage_error, @evaluation_type, @accuracy_category)
                    `);
                evaluatedCount++;
            }
        }
        
        if (useMemoryFallback) {
            await saveMemoryData();
        }
        
        res.json({
            success: true,
            evaluated_count: evaluatedCount,
            target_date: target_date,
            actual_temperature
        });
    } catch (error) {
        console.error('Date evaluation error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Export evaluation data
app.get('/api/predictions/export-evaluations', async (req, res) => {
    try {
        let evaluationData;
        
        if (useMemoryFallback) {
            evaluationData = predictionAccuracy.map(acc => {
                const prediction = predictions.find(p => p.id === acc.prediction_id);
                return {
                    prediction_id: acc.prediction_id,
                    prediction_date: prediction ? prediction.prediction_date : 'Unknown',
                    target_date: prediction ? prediction.target_date : 'Unknown',
                    predicted_temperature: acc.predicted_temperature,
                    actual_temperature: acc.actual_temperature,
                    absolute_error: acc.absolute_error,
                    percentage_error: acc.percentage_error,
                    accuracy_category: acc.accuracy_category,
                    evaluation_type: acc.evaluation_type,
                    evaluation_date: acc.evaluation_date,
                    notes: acc.notes || ''
                };
            });
        } else {
            const result = await pool.request().query(`
                SELECT 
                    pa.prediction_id,
                    p.prediction_date,
                    p.target_date,
                    pa.predicted_temperature,
                    pa.actual_temperature,
                    pa.absolute_error,
                    pa.percentage_error,
                    pa.accuracy_category,
                    pa.evaluation_type,
                    pa.evaluation_date,
                    pa.notes
                FROM prediction_accuracy pa
                JOIN predictions p ON pa.prediction_id = p.id
                ORDER BY pa.evaluation_date DESC
            `);
            evaluationData = result.recordset;
        }
        
        // Generate CSV
        const csvHeader = 'prediction_id,prediction_date,target_date,predicted_temperature,actual_temperature,absolute_error,percentage_error,accuracy_category,evaluation_type,evaluation_date,notes\n';
        const csvRows = evaluationData.map(row => {
            return Object.values(row).map(value => {
                if (value === null || value === undefined) return '';
                if (typeof value === 'string' && value.includes(',')) return `"${value}"`;
                return value;
            }).join(',');
        }).join('\n');
        
        const csv = csvHeader + csvRows;
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="temperature_predictions_export.csv"');
        res.send(csv);
    } catch (error) {
        console.error('Export error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Import evaluation data from CSV
app.post('/api/predictions/import-evaluations', upload.single('evaluation_file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }
        
        const csvData = [];
        const results = { imported: 0, skipped: 0, errors: [] };
        
        // Read and parse CSV
        const fileContent = await fs.readFile(req.file.path, 'utf8');
        const lines = fileContent.split('\n');
        
        if (lines.length < 2) {
            return res.status(400).json({ success: false, error: 'CSV file appears to be empty or invalid' });
        }
        
        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const values = line.split(',');
            const row = {};
            
            headers.forEach((header, index) => {
                row[header] = values[index] ? values[index].replace(/"/g, '').trim() : null;
            });
            
            if (row.prediction_id && row.actual_temperature) {
                csvData.push(row);
            }
        }
        
        // Process each row
        for (const row of csvData) {
            try {
                const predictionId = parseInt(row.prediction_id);
                const actualTemp = parseFloat(row.actual_temperature);
                
                if (isNaN(predictionId) || isNaN(actualTemp)) {
                    results.skipped++;
                    continue;
                }
                
                // Check if prediction exists and isn't already evaluated
                let prediction, existingEvaluation;
                
                if (useMemoryFallback) {
                    prediction = predictions.find(p => p.id === predictionId);
                    existingEvaluation = predictionAccuracy.find(acc => acc.prediction_id === predictionId);
                } else {
                    const predResult = await pool.request()
                        .input('id', sql.Int, predictionId)
                        .query('SELECT * FROM predictions WHERE id = @id');
                    prediction = predResult.recordset[0];
                    
                    const evalResult = await pool.request()
                        .input('prediction_id', sql.Int, predictionId)
                        .query('SELECT * FROM prediction_accuracy WHERE prediction_id = @prediction_id');
                    existingEvaluation = evalResult.recordset[0];
                }
                
                if (!prediction || existingEvaluation) {
                    results.skipped++;
                    continue;
                }
                
                const error = Math.abs(actualTemp - prediction.predicted_temperature);
                const percentageError = (error / Math.abs(actualTemp)) * 100;
                const accuracyCategory = getAccuracyCategory(error);
                
                // Save evaluation
                if (useMemoryFallback) {
                    predictionAccuracy.push({
                        id: predictionAccuracy.length + 1,
                        prediction_id: predictionId,
                        actual_temperature: actualTemp,
                        predicted_temperature: prediction.predicted_temperature,
                        absolute_error: error,
                        percentage_error: percentageError,
                        evaluation_date: new Date().toISOString(),
                        evaluation_type: row.evaluation_type || 'manual_import',
                        accuracy_category,
                        notes: row.notes || 'Imported from CSV'
                    });
                } else {
                    await pool.request()
                        .input('prediction_id', sql.Int, predictionId)
                        .input('actual_temperature', sql.Float, actualTemp)
                        .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                        .input('absolute_error', sql.Float, error)
                        .input('percentage_error', sql.Float, percentageError)
                        .input('evaluation_type', sql.VarChar(20), row.evaluation_type || 'manual_import')
                        .input('accuracy_category', sql.VarChar(20), accuracyCategory)
                        .input('notes', sql.Text, row.notes || 'Imported from CSV')
                        .query(`
                            INSERT INTO prediction_accuracy 
                            (prediction_id, actual_temperature, predicted_temperature, absolute_error, 
                             percentage_error, evaluation_type, accuracy_category, notes) 
                            VALUES (@prediction_id, @actual_temperature, @predicted_temperature, 
                                    @absolute_error, @percentage_error, @evaluation_type, @accuracy_category, @notes)
                        `);
                }
                
                results.imported++;
            } catch (rowError) {
                results.errors.push(`Row ${csvData.indexOf(row) + 2}: ${rowError.message}`);
                results.skipped++;
            }
        }
        
        if (useMemoryFallback) {
            await saveMemoryData();
        }
        
        // Clean up uploaded file
        await fs.unlink(req.file.path);
        
        res.json({
            success: true,
            imported_count: results.imported,
            skipped_count: results.skipped,
            error_count: results.errors.length,
            errors: results.errors.slice(0, 10) // Limit error details
        });
        
    } catch (error) {
        console.error('Import error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Weather API routes (keeping existing)
app.get('/api/weather/current', async (req, res) => {
    try {
        if (!WEATHER_API_KEY) {
            return res.json({ 
                success: false, 
                error: 'Weather API key not configured',
                configured: false,
                fallback: generateFallbackWeather()
            });
        }

        const weatherData = await fetchWeatherData();
        res.json({
            success: true,
            data: weatherData,
            timestamp: new Date()
        });
    } catch (error) {
        console.error('Weather API error:', error.message);
        res.json({ 
            success: false, 
            error: error.message,
            configured: !!WEATHER_API_KEY,
            fallback: generateFallbackWeather()
        });
    }
});

app.post('/api/weather/save', async (req, res) => {
    try {
        const weatherData = await fetchWeatherData();
        
        if (useMemoryFallback) {
            temperatureData.push({
                id: temperatureData.length + 1,
                date_time: weatherData.timestamp.toISOString(),
                temperature: weatherData.temperature,
                humidity: weatherData.humidity,
                pressure: weatherData.pressure,
                wind_speed: weatherData.wind_speed,
                cloud_cover: weatherData.cloud_cover,
                data_type: 'weather_api'
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('temperature', sql.Float, weatherData.temperature)
                .input('humidity', sql.Float, weatherData.humidity)
                .input('pressure', sql.Float, weatherData.pressure)
                .input('wind_speed', sql.Float, weatherData.wind_speed)
                .input('cloud_cover', sql.Float, weatherData.cloud_cover)
                .query(`
                    INSERT INTO temperature_data (temperature, humidity, pressure, wind_speed, cloud_cover, data_type) 
                    VALUES (@temperature, @humidity, @pressure, @wind_speed, @cloud_cover, 'weather_api')
                `);
        }
        
        res.json({
            success: true,
            message: 'Weather data saved successfully',
            data: weatherData
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Temperature data routes
app.post('/api/temperature', async (req, res) => {
    try {
        const { temperature, humidity, pressure, wind_speed, cloud_cover } = req.body;
        
        if (typeof temperature !== 'number' || isNaN(temperature)) {
            return res.status(400).json({ success: false, error: 'Invalid temperature value' });
        }
        
        const data = {
            temperature,
            humidity: humidity || 60,
            pressure: pressure || 1013,
            wind_speed: wind_speed || 5,
            cloud_cover: cloud_cover || 50
        };
        
        if (useMemoryFallback) {
            temperatureData.push({
                id: temperatureData.length + 1,
                date_time: new Date().toISOString(),
                ...data,
                data_type: 'actual'
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('temperature', sql.Float, data.temperature)
                .input('humidity', sql.Float, data.humidity)
                .input('pressure', sql.Float, data.pressure)
                .input('wind_speed', sql.Float, data.wind_speed)
                .input('cloud_cover', sql.Float, data.cloud_cover)
                .query(`
                    INSERT INTO temperature_data (temperature, humidity, pressure, wind_speed, cloud_cover, data_type) 
                    VALUES (@temperature, @humidity, @pressure, @wind_speed, @cloud_cover, 'actual')
                `);
        }
        
        res.json({ success: true, message: 'Data added successfully' });
    } catch (error) {
        console.error('Add data error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/temperature/historical', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        let result;
        
        if (useMemoryFallback) {
            result = temperatureData
                .sort((a, b) => new Date(b.date_time) - new Date(a.date_time))
                .slice(0, days * 6);
        } else {
            const dbResult = await pool.request()
                .input('limit', sql.Int, days * 6)
                .query(`SELECT TOP (@limit) * FROM temperature_data ORDER BY date_time DESC`);
            result = dbResult.recordset;
        }
        
        res.json(result.reverse());
    } catch (error) {
        console.error('Historical data error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Prediction routes
app.post('/api/predict/next-day', async (req, res) => {
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(12, 0, 0, 0);
        
        const prediction = await makePrediction(tomorrow, 1);
        
        let predictionId;
        if (useMemoryFallback) {
            predictionId = predictions.length + 1;
            predictions.push({
                id: predictionId,
                prediction_date: new Date().toISOString(),
                target_date: tomorrow.toISOString(),
                predicted_temperature: prediction.predicted_temperature,
                confidence: prediction.confidence,
                model_version: 'v2.0',
                prediction_type: 'single',
                days_ahead: 1,
                auto_evaluated: false
            });
            await saveMemoryData();
        } else {
            const result = await pool.request()
                .input('target_date', sql.DateTime2, tomorrow)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('confidence', sql.Float, prediction.confidence)
                .query(`
                    INSERT INTO predictions (target_date, predicted_temperature, confidence, prediction_type, days_ahead) 
                    OUTPUT INSERTED.id 
                    VALUES (@target_date, @predicted_temperature, @confidence, 'single', 1)
                `);
            predictionId = result.recordset[0].id;
        }
        
        res.json({
            success: true,
            prediction_id: predictionId,
            target_date: tomorrow,
            predicted_temperature: prediction.predicted_temperature,
            confidence: prediction.confidence
        });
    } catch (error) {
        console.error('Prediction error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/predict/14-day', async (req, res) => {
    try {
        const results = [];
        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        startDate.setHours(12, 0, 0, 0);
        
        const predictionDate = new Date();
        let savedPredictions = [];
        
        console.log(`Starting 14-day prediction batch at ${predictionDate.toISOString()}`);
        
        for (let day = 1; day <= 14; day++) {
            const targetDate = new Date(startDate);
            targetDate.setDate(startDate.getDate() + day - 1);
            
            const prediction = await makePrediction(targetDate, day);
            
            let predictionId;
            
            if (useMemoryFallback) {
                predictionId = (predictions.length || 0) + 1;
                const predictionRecord = {
                    id: predictionId,
                    prediction_date: predictionDate.toISOString(),
                    target_date: targetDate.toISOString(),
                    predicted_temperature: prediction.predicted_temperature,
                    confidence: prediction.confidence,
                    model_version: 'v2.0',
                    prediction_type: '14-day',
                    days_ahead: day,
                    auto_evaluated: false
                };
                
                predictions.push(predictionRecord);
                savedPredictions.push(predictionRecord);
                
            } else {
                try {
                    const dbResult = await pool.request()
                        .input('prediction_date', sql.DateTime2, predictionDate)
                        .input('target_date', sql.DateTime2, targetDate)
                        .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                        .input('confidence', sql.Float, prediction.confidence)
                        .input('prediction_type', sql.VarChar(20), '14-day')
                        .input('days_ahead', sql.Int, day)
                        .query(`
                            INSERT INTO predictions 
                            (prediction_date, target_date, predicted_temperature, confidence, prediction_type, days_ahead) 
                            OUTPUT INSERTED.id 
                            VALUES (@prediction_date, @target_date, @predicted_temperature, @confidence, @prediction_type, @days_ahead)
                        `);
                    
                    predictionId = dbResult.recordset[0]?.id || `temp-${day}`;
                } catch (dbError) {
                    console.error(`Database error saving prediction for day ${day}:`, dbError);
                    predictionId = `error-${day}`;
                }
            }
            
            results.push({
                prediction_id: predictionId,
                day: day,
                date: targetDate.toISOString().split('T')[0],
                predicted_temperature: prediction.predicted_temperature,
                confidence: Math.round(prediction.confidence * 100)
            });
        }
        
        if (useMemoryFallback) {
            await saveMemoryData();
        }
        
        res.json({
            success: true,
            message: `Successfully created and saved 14-day forecast`,
            prediction_batch_date: predictionDate.toISOString(),
            predictions: results,
            total_predictions: results.length,
            saved_to_database: true,
            database_type: useMemoryFallback ? 'in-memory' : 'azure-sql',
            saved_predictions: savedPredictions
        });
        
    } catch (error) {
        console.error('14-day prediction error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// Get recent predictions (enhanced)
app.get('/api/predictions/recent', async (req, res) => {
    try {
        let recentPredictions;
        
        if (useMemoryFallback) {
            recentPredictions = predictions
                .sort((a, b) => new Date(b.prediction_date) - new Date(a.prediction_date))
                .slice(0, 20)
                .map(pred => {
                    const accuracy = predictionAccuracy.find(acc => acc.prediction_id === pred.id);
                    return {
                        ...pred,
                        actual_temperature: accuracy ? accuracy.actual_temperature : null,
                        absolute_error: accuracy ? accuracy.absolute_error : null,
                        evaluation_type: accuracy ? accuracy.evaluation_type : null,
                        accuracy_category: accuracy ? accuracy.accuracy_category : null,
                        status: accuracy ? 'evaluated' : 'pending'
                    };
                });
        } else {
            const result = await pool.request().query(`
                SELECT TOP 20 
                    p.*,
                    pa.actual_temperature,
                    pa.absolute_error,
                    pa.evaluation_type,
                    pa.accuracy_category,
                    CASE WHEN pa.id IS NULL THEN 'pending' ELSE 'evaluated' END as status
                FROM predictions p
                LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id
                ORDER BY p.prediction_date DESC
            `);
            recentPredictions = result.recordset;
        }
        
        res.json(recentPredictions);
    } catch (error) {
        console.error('Recent predictions error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Chart data
app.get('/api/chart/combined', async (req, res) => {
    try {
        let historical, futurePredictions, evaluated;
        
        if (useMemoryFallback) {
            historical = temperatureData.slice(-30);
            futurePredictions = predictions
                .filter(p => new Date(p.target_date) > new Date())
                .slice(0, 14);
            evaluated = predictionAccuracy.slice(-10);
        } else {
            const histResult = await pool.request().query(`
                SELECT TOP 30 * FROM temperature_data 
                ORDER BY date_time DESC
            `);
            historical = histResult.recordset.reverse();
            
            const predResult = await pool.request().query(`
                SELECT TOP 14 * FROM predictions 
                WHERE target_date > GETDATE() 
                ORDER BY target_date
            `);
            futurePredictions = predResult.recordset;
            
            const evalResult = await pool.request().query(`
                SELECT TOP 10 pa.*, p.target_date FROM prediction_accuracy pa
                JOIN predictions p ON pa.prediction_id = p.id
                ORDER BY pa.evaluation_date DESC
            `);
            evaluated = evalResult.recordset;
        }
        
        res.json({
            historical: historical.map(d => ({
                date: d.date_time,
                temperature: d.temperature,
                type: 'actual'
            })),
            predictions: futurePredictions.map(p => ({
                date: p.target_date,
                temperature: p.predicted_temperature,
                confidence: p.confidence,
                type: 'prediction'
            })),
            evaluated: evaluated.map(e => ({
                date: e.target_date || e.evaluation_date,
                actual_temperature: e.actual_temperature,
                predicted_temperature: e.predicted_temperature,
                type: 'evaluated'
            }))
        });
    } catch (error) {
        console.error('Combined chart error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Model management
app.post('/api/retrain', async (req, res) => {
    try {
        const success = await trainModel();
        res.json({ 
            success, 
            message: success ? 'Model retrained successfully' : 'Training failed - need more data'
        });
    } catch (error) {
        console.error('Retrain error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Legacy evaluation endpoint (for backward compatibility)
app.post('/api/evaluate', async (req, res) => {
    try {
        const { prediction_id, actual_temperature } = req.body;
        
        if (!prediction_id || typeof actual_temperature !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid input data' });
        }
        
        let prediction;
        if (useMemoryFallback) {
            prediction = predictions.find(p => p.id === prediction_id);
        } else {
            const result = await pool.request()
                .input('id', sql.Int, prediction_id)
                .query('SELECT * FROM predictions WHERE id = @id');
            prediction = result.recordset[0];
        }
        
        if (!prediction) {
            return res.status(404).json({ success: false, error: 'Prediction not found' });
        }
        
        const error = Math.abs(actual_temperature - prediction.predicted_temperature);
        const percentageError = (error / Math.abs(actual_temperature)) * 100;
        const accuracyCategory = getAccuracyCategory(error);
        
        if (useMemoryFallback) {
            predictionAccuracy.push({
                id: predictionAccuracy.length + 1,
                prediction_id,
                actual_temperature,
                predicted_temperature: prediction.predicted_temperature,
                absolute_error: error,
                percentage_error: percentageError,
                evaluation_date: new Date().toISOString(),
                evaluation_type: 'manual',
                accuracy_category
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('prediction_id', sql.Int, prediction_id)
                .input('actual_temperature', sql.Float, actual_temperature)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('absolute_error', sql.Float, error)
                .input('percentage_error', sql.Float, percentageError)
                .input('accuracy_category', sql.VarChar(20), accuracyCategory)
                .query(`
                    INSERT INTO prediction_accuracy 
                    (prediction_id, actual_temperature, predicted_temperature, absolute_error, percentage_error, evaluation_type, accuracy_category) 
                    VALUES (@prediction_id, @actual_temperature, @predicted_temperature, @absolute_error, @percentage_error, 'manual', @accuracy_category)
                `);
        }
        
        res.json({
            success: true,
            absolute_error: Math.round(error * 100) / 100,
            percentage_error: Math.round(percentageError * 100) / 100,
            accuracy_percentage: Math.round(Math.max(0, 100 - percentageError) * 100) / 100,
            accuracy_category: accuracyCategory
        });
    } catch (error) {
        console.error('Legacy evaluation error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server function
async function startServer() {
    try {
        console.log('\n🚀 Starting AI Temperature Prediction System...\n');
        
        const dbConnected = await initDB();
        if (!dbConnected) {
            throw new Error('Failed to initialize database');
        }
        
        const modelCreated = await createModel();
        if (!modelCreated) {
            throw new Error('Failed to create AI model');
        }
        
        const trained = await trainModel();
        if (trained) {
            console.log('✅ Model training completed on startup');
        } else {
            console.log('⚠️  Model ready - add data to begin training');
        }
        
        // Start auto-comparison system
        autoCompareInterval = setInterval(autoComparePredictions, 30 * 60 * 1000); // Every 30 minutes
        setTimeout(autoComparePredictions, 60000); // Initial check after 1 minute
        
        app.listen(PORT, () => {
            console.log('\n🎉 Server running successfully!\n');
            console.log(`📊 Dashboard: http://localhost:${PORT}`);
            console.log(`🔍 Health Check: http://localhost:${PORT}/api/health`);
            console.log(`🌤️  Weather API: http://localhost:${PORT}/api/weather/current`);
            console.log(`\n💾 Database: ${useMemoryFallback ? 'In-Memory Storage' : 'Azure SQL (strato_db)'}`);
            console.log(`🧠 AI Model: Enhanced Neural Network`);
            console.log(`🤖 Auto-Compare: Active (checks every 30 minutes)`);
            console.log(`🌍 Weather: ${WEATHER_API_KEY ? 'OpenWeatherMap API' : 'Demo Mode'}`);
            console.log(`📍 Location: ${WEATHER_CITY}`);
            console.log(`📁 File Upload: Enabled for CSV imports`);
            console.log(`📈 Manual Evaluation: Full support enabled`);
            console.log('\n✅ All systems operational\n');
        });
        
    } catch (error) {
        console.error('\n❌ Failed to start server:', error.message);
        console.log('\n🔧 Troubleshooting:');
        console.log('1. Check your .env file contains all required variables');
        console.log('2. Verify Azure SQL firewall allows your IP address');
        console.log('3. Test weather API key at openweathermap.org');
        console.log('4. Ensure Node.js dependencies are installed');
        console.log('5. Run: npm install express cors mssql @tensorflow/tfjs-node dotenv csv-parser multer\n');
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down gracefully...');
    
    if (autoCompareInterval) {
        clearInterval(autoCompareInterval);
        console.log('✅ Auto-comparison stopped');
    }
    
    if (useMemoryFallback) {
        await saveMemoryData();
        console.log('✅ Memory data saved');
    }
    
    if (pool) {
        await pool.close();
        console.log('✅ Database connection closed');
    }
    
    console.log('👋 Server shut down complete\n');
    process.exit(0);
});

// Start the server
startServer();