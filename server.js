const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs').promises;
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const WEATHER_CITY = process.env.WEATHER_CITY || 'Jersey';
const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

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

// Create tables
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
                    auto_evaluated BIT DEFAULT 0
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
                    evaluation_type VARCHAR(20) DEFAULT 'manual'
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

// Weather API
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

// Generate fallback weather data
function generateFallbackWeather() {
    const baseTemp = 18 + (Math.random() * 8); // 18-26°C
    return {
        temperature: Math.round(baseTemp * 10) / 10,
        humidity: 50 + Math.round(Math.random() * 30), // 50-80%
        pressure: 1003 + Math.round(Math.random() * 20), // 1003-1023 hPa
        wind_speed: Math.round(Math.random() * 15 * 10) / 10, // 0-15 km/h
        cloud_cover: Math.round(Math.random() * 100), // 0-100%
        weather_description: 'simulated data',
        city: WEATHER_CITY || 'Demo City',
        country: 'Demo',
        timestamp: new Date()
    };
}

// Auto-comparison system
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
            const tolerance = 2 * 60 * 60 * 1000; // 2 hours tolerance
            
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
                
                // Save evaluation
                if (useMemoryFallback) {
                    predictionAccuracy.push({
                        id: predictionAccuracy.length + 1,
                        prediction_id: prediction.id,
                        actual_temperature: actualData.temperature,
                        predicted_temperature: prediction.predicted_temperature,
                        absolute_error: error,
                        percentage_error: percentageError,
                        evaluation_date: new Date().toISOString(),
                        evaluation_type: 'auto'
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
                        .query(`
                            INSERT INTO prediction_accuracy 
                            (prediction_id, actual_temperature, predicted_temperature, absolute_error, percentage_error, evaluation_type) 
                            VALUES (@prediction_id, @actual_temperature, @predicted_temperature, @absolute_error, @percentage_error, 'auto')
                        `);
                    
                    await pool.request()
                        .input('id', sql.Int, prediction.id)
                        .query('UPDATE predictions SET auto_evaluated = 1 WHERE id = @id');
                }
                
                console.log(`✅ Auto-evaluated prediction #${prediction.id}: ${error.toFixed(2)}°C error`);
            }
        }
    } catch (error) {
        console.error('Auto-comparison failed:', error.message);
    }
}

// AI Model
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

// Train model
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
        
        // Feature engineering
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
        
        // Normalization
        const temps = processedData.map(d => d.temperature);
        const tempMean = temps.reduce((a, b) => a + b) / temps.length;
        const tempStd = Math.sqrt(temps.map(t => (t - tempMean) ** 2).reduce((a, b) => a + b) / temps.length);
        
        normalizationParams = { tempMean, tempStd };
        
        // Prepare features
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
        
        // Train
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

// Prediction function
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

// Memory management
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

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
    try {
        let stats;
        
        if (useMemoryFallback) {
            stats = { 
                total_records: temperatureData.length, 
                predictions: predictions.length,
                accuracy_records: predictionAccuracy.length,
                auto_evaluated: predictionAccuracy.filter(acc => acc.evaluation_type === 'auto').length
            };
        } else {
            try {
                const result = await pool.request().query(`
                    SELECT 
                        (SELECT COUNT(*) FROM temperature_data) as total_records,
                        (SELECT COUNT(*) FROM predictions) as predictions,
                        (SELECT COUNT(*) FROM prediction_accuracy) as accuracy_records,
                        (SELECT COUNT(*) FROM prediction_accuracy WHERE evaluation_type = 'auto') as auto_evaluated
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

// Weather API
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

// Save weather data
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

// Add temperature data
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

// Single day prediction
app.post('/api/predict/next-day', async (req, res) => {
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(12, 0, 0, 0);
        
        const prediction = await makePrediction(tomorrow, 1);
        
        // Save prediction
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

// 14-day prediction
app.post('/api/predict/14-day', async (req, res) => {
    try {
        const results = [];
        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        startDate.setHours(12, 0, 0, 0);
        
        for (let day = 1; day <= 14; day++) {
            const targetDate = new Date(startDate);
            targetDate.setDate(startDate.getDate() + day - 1);
            
            const prediction = await makePrediction(targetDate, day);
            
            results.push({
                day: day,
                date: targetDate.toISOString().split('T')[0],
                predicted_temperature: prediction.predicted_temperature,
                confidence: Math.round(prediction.confidence * 100)
            });
        }
        
        res.json({
            success: true,
            predictions: results,
            total_predictions: results.length
        });
    } catch (error) {
        console.error('14-day prediction error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get analytics
app.get('/api/analytics', async (req, res) => {
    try {
        let data, accuracyData;
        
        if (useMemoryFallback) {
            data = temperatureData;
            accuracyData = predictionAccuracy;
        } else {
            const tempResult = await pool.request().query('SELECT * FROM temperature_data ORDER BY date_time');
            const accResult = await pool.request().query('SELECT * FROM prediction_accuracy ORDER BY evaluation_date');
            data = tempResult.recordset;
            accuracyData = accResult.recordset;
        }
        
        const analytics = {
            total_data_points: data.length,
            total_predictions: accuracyData.length,
            average_error: accuracyData.length > 0 ? 
                accuracyData.reduce((sum, a) => sum + a.absolute_error, 0) / accuracyData.length : 0,
            recent_accuracy: accuracyData.slice(-10).length > 0 ?
                accuracyData.slice(-10).reduce((sum, a) => sum + (100 - a.percentage_error), 0) / accuracyData.slice(-10).length : 0,
            auto_evaluations: accuracyData.filter(a => a.evaluation_type === 'auto').length
        };
        
        res.json(analytics);
    } catch (error) {
        console.error('Analytics error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get recent predictions
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

// Get historical data
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

// Combined chart data
app.get('/api/chart/combined', async (req, res) => {
    try {
        let historical, futurePredictions;
        
        if (useMemoryFallback) {
            historical = temperatureData.slice(-30);
            futurePredictions = predictions
                .filter(p => new Date(p.target_date) > new Date())
                .slice(0, 14);
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
            }))
        });
    } catch (error) {
        console.error('Combined chart error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Retrain model
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

// Evaluate prediction
app.post('/api/evaluate', async (req, res) => {
    try {
        const { prediction_id, actual_temperature } = req.body;
        
        if (!prediction_id || typeof actual_temperature !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid input data' });
        }
        
        // Get prediction
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
        
        // Save accuracy record
        if (useMemoryFallback) {
            predictionAccuracy.push({
                id: predictionAccuracy.length + 1,
                prediction_id,
                actual_temperature,
                predicted_temperature: prediction.predicted_temperature,
                absolute_error: error,
                percentage_error: percentageError,
                evaluation_date: new Date().toISOString(),
                evaluation_type: 'manual'
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('prediction_id', sql.Int, prediction_id)
                .input('actual_temperature', sql.Float, actual_temperature)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('absolute_error', sql.Float, error)
                .input('percentage_error', sql.Float, percentageError)
                .query(`
                    INSERT INTO prediction_accuracy 
                    (prediction_id, actual_temperature, predicted_temperature, absolute_error, percentage_error, evaluation_type) 
                    VALUES (@prediction_id, @actual_temperature, @predicted_temperature, @absolute_error, @percentage_error, 'manual')
                `);
        }
        
        res.json({
            success: true,
            absolute_error: Math.round(error * 100) / 100,
            percentage_error: Math.round(percentageError * 100) / 100,
            accuracy_percentage: Math.round(Math.max(0, 100 - percentageError) * 100) / 100
        });
    } catch (error) {
        console.error('Evaluation error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server function
async function startServer() {
    try {
        console.log('\n🚀 Starting AI Temperature Prediction System...\n');
        
        // Initialize database
        const dbConnected = await initDB();
        if (!dbConnected) {
            throw new Error('Failed to initialize database');
        }
        
        // Create and train AI model
        const modelCreated = await createModel();
        if (!modelCreated) {
            throw new Error('Failed to create AI model');
        }
        
        // Try to train with existing data
        const trained = await trainModel();
        if (trained) {
            console.log('✅ Model training completed on startup');
        } else {
            console.log('⚠️  Model ready - add data to begin training');
        }
        
        // Start auto-comparison system
        autoCompareInterval = setInterval(autoComparePredictions, 30 * 60 * 1000); // Every 30 minutes
        setTimeout(autoComparePredictions, 60000); // Initial check after 1 minute
        
        // Start server
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
            console.log('\n✅ All systems operational\n');
        });
        
    } catch (error) {
        console.error('\n❌ Failed to start server:', error.message);
        console.log('\n🔧 Troubleshooting:');
        console.log('1. Check your .env file contains all required variables');
        console.log('2. Verify Azure SQL firewall allows your IP address');
        console.log('3. Test weather API key at openweathermap.org');
        console.log('4. Ensure Node.js dependencies are installed\n');
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