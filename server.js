const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs').promises;
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Weather API configuration
const WEATHER_API_KEY = process.env.WEATHER_API_KEY; // Get from OpenWeatherMap
const WEATHER_CITY = process.env.WEATHER_CITY || 'London'; // Default city
const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database configuration
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME || 'strato_db',
    options: { encrypt: true, trustServerCertificate: false }
};

// Global variables
let pool, model, normalizationParams = {};
let useMemoryFallback = false;
let temperatureData = [], predictions = [], predictionAccuracy = [];
let weatherUpdateInterval;

// Initialize database with fallback
async function initDB() {
    try {
        if (!dbConfig.server || !dbConfig.user || !dbConfig.password) {
            throw new Error('Missing database credentials');
        }
        
        pool = await sql.connect(dbConfig);
        await pool.request().query('SELECT 1');
        console.log('✅ Connected to Azure SQL (strato_db)');
        
        await createTables();
        return true;
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        
        if (process.env.ENABLE_MEMORY_FALLBACK === 'true') {
            console.log('🔄 Using in-memory fallback...');
            useMemoryFallback = true;
            await loadMemoryData();
            return true;
        }
        throw err;
    }
}

// Create database tables
async function createTables() {
    try {
        const existingTables = await pool.request().query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_TYPE = 'BASE TABLE'
        `);
        
        const tableNames = existingTables.recordset.map(row => row.TABLE_NAME.toLowerCase());
        
        if (!tableNames.includes('temperature_data')) {
            await pool.request().query(`
                CREATE TABLE temperature_data (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    date_time DATETIME2 NOT NULL,
                    temperature FLOAT NOT NULL,
                    humidity FLOAT DEFAULT 60,
                    pressure FLOAT DEFAULT 1013,
                    wind_speed FLOAT DEFAULT 5,
                    cloud_cover FLOAT DEFAULT 50,
                    data_type VARCHAR(50) DEFAULT 'actual',
                    created_at DATETIME2 DEFAULT GETDATE()
                )
            `);
        }
        
        if (!tableNames.includes('predictions')) {
            await pool.request().query(`
                CREATE TABLE predictions (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    prediction_date DATETIME2 DEFAULT GETDATE(),
                    target_date DATETIME2 NOT NULL,
                    predicted_temperature FLOAT NOT NULL,
                    confidence FLOAT DEFAULT 0.8,
                    features_used TEXT,
                    model_version VARCHAR(50) DEFAULT 'v1.0'
                )
            `);
        }
        
        if (!tableNames.includes('prediction_accuracy')) {
            await pool.request().query(`
                CREATE TABLE prediction_accuracy (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    prediction_id INT NOT NULL,
                    actual_temperature FLOAT NOT NULL,
                    predicted_temperature FLOAT NOT NULL,
                    absolute_error FLOAT NOT NULL,
                    percentage_error FLOAT NOT NULL,
                    evaluation_date DATETIME2 DEFAULT GETDATE()
                )
            `);
        }
        
        console.log('✅ Database tables ready');
    } catch (err) {
        console.error('❌ Error with database tables:', err.message);
        throw err;
    }
}

// Weather API functions
async function fetchWeatherData() {
    return new Promise((resolve, reject) => {
        if (!WEATHER_API_KEY) {
            reject(new Error('Weather API key not configured'));
            return;
        }

        const url = `${WEATHER_API_URL}?q=${WEATHER_CITY}&appid=${WEATHER_API_KEY}&units=metric`;
        
        https.get(url, (response) => {
            let data = '';
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                try {
                    const weatherData = JSON.parse(data);
                    
                    if (weatherData.cod === 200) {
                        const processedData = {
                            temperature: Math.round(weatherData.main.temp * 10) / 10,
                            humidity: weatherData.main.humidity,
                            pressure: weatherData.main.pressure,
                            wind_speed: Math.round((weatherData.wind?.speed || 0) * 3.6 * 10) / 10, // Convert m/s to km/h
                            cloud_cover: weatherData.clouds?.all || 0,
                            weather_description: weatherData.weather[0]?.description || 'unknown',
                            city: weatherData.name,
                            country: weatherData.sys?.country || '',
                            timestamp: new Date()
                        };
                        resolve(processedData);
                    } else {
                        reject(new Error(`Weather API error: ${weatherData.message || 'Unknown error'}`));
                    }
                } catch (error) {
                    reject(new Error('Failed to parse weather data'));
                }
            });
        }).on('error', (error) => {
            reject(new Error(`Weather API request failed: ${error.message}`));
        });
    });
}

async function saveWeatherDataToDB(weatherData) {
    try {
        if (useMemoryFallback) {
            temperatureData.push({
                id: temperatureData.length + 1,
                date_time: weatherData.timestamp.toISOString(),
                temperature: weatherData.temperature,
                humidity: weatherData.humidity,
                pressure: weatherData.pressure,
                wind_speed: weatherData.wind_speed,
                cloud_cover: weatherData.cloud_cover,
                data_type: 'weather_api',
                weather_description: weatherData.weather_description,
                location: `${weatherData.city}, ${weatherData.country}`
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('date_time', sql.DateTime2, weatherData.timestamp)
                .input('temperature', sql.Float, weatherData.temperature)
                .input('humidity', sql.Float, weatherData.humidity)
                .input('pressure', sql.Float, weatherData.pressure)
                .input('wind_speed', sql.Float, weatherData.wind_speed)
                .input('cloud_cover', sql.Float, weatherData.cloud_cover)
                .input('data_type', sql.VarChar, 'weather_api')
                .query(`INSERT INTO temperature_data (date_time, temperature, humidity, pressure, wind_speed, cloud_cover, data_type) 
                        VALUES (@date_time, @temperature, @humidity, @pressure, @wind_speed, @cloud_cover, @data_type)`);
        }
        
        console.log(`Weather data saved: ${weatherData.temperature}°C in ${weatherData.city}`);
        return true;
    } catch (error) {
        console.error('Error saving weather data:', error);
        return false;
    }
}

async function updateWeatherData() {
    try {
        const weatherData = await fetchWeatherData();
        await saveWeatherDataToDB(weatherData);
        return weatherData;
    } catch (error) {
        console.error('Weather update failed:', error.message);
        return null;
    }
}

function startWeatherUpdates() {
    if (!WEATHER_API_KEY) {
        console.log('Weather API key not configured - skipping automatic updates');
        return;
    }

    // Update weather data every hour
    weatherUpdateInterval = setInterval(async () => {
        await updateWeatherData();
    }, 60 * 60 * 1000); // 1 hour

    // Initial weather data fetch
    setTimeout(async () => {
        const initialData = await updateWeatherData();
        if (initialData) {
            console.log(`Weather API initialized: ${initialData.city}, ${initialData.country}`);
        }
    }, 5000); // Wait 5 seconds after startup
}
async function loadMemoryData() {
    try {
        const data = JSON.parse(await fs.readFile('strato_data.json', 'utf8'));
        temperatureData = data.temperatureData || [];
        predictions = data.predictions || [];
        predictionAccuracy = data.predictionAccuracy || [];
        console.log(`📁 Loaded ${temperatureData.length} records from file`);
    } catch (err) {
        console.log('📄 Creating new data file');
    }
}

async function saveMemoryData() {
    if (!useMemoryFallback) return;
    await fs.writeFile('strato_data.json', JSON.stringify({
        temperatureData, predictions, predictionAccuracy, lastSaved: new Date()
    }, null, 2));
}

// Create AI model
async function createModel() {
    model = tf.sequential({
        layers: [
            tf.layers.dense({ inputShape: [6], units: 64, activation: 'relu' }),
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
}

// Train model
async function trainModel() {
    try {
        let data;
        
        if (useMemoryFallback) {
            data = temperatureData.filter(d => d.data_type === 'actual').slice(-1000);
        } else {
            const result = await pool.request().query(`
                SELECT TOP 1000 temperature, humidity, pressure, wind_speed, cloud_cover, date_time
                FROM temperature_data WHERE data_type = 'actual' ORDER BY date_time DESC
            `);
            data = result.recordset;
        }
        
        if (data.length < 10) {
            console.log('⚠️ Need at least 10 data points to train model');
            return false;
        }
        
        // Add previous temperature feature
        const processedData = [];
        for (let i = 1; i < data.length; i++) {
            processedData.push({
                ...data[i],
                prev_temp: data[i-1].temperature
            });
        }
        
        // Calculate normalization
        const temps = processedData.map(d => d.temperature);
        const tempMean = temps.reduce((a, b) => a + b) / temps.length;
        const tempStd = Math.sqrt(temps.map(t => (t - tempMean) ** 2).reduce((a, b) => a + b) / temps.length);
        
        normalizationParams = { tempMean, tempStd };
        
        // Prepare features and labels
        const features = processedData.map(d => [
            (d.prev_temp - tempMean) / tempStd,
            d.humidity / 100,
            (d.pressure - 1013) / 50,
            d.wind_speed / 30,
            d.cloud_cover / 100,
            Math.sin(2 * Math.PI * new Date(d.date_time).getHours() / 24)
        ]);
        
        const labels = processedData.map(d => (d.temperature - tempMean) / tempStd);
        
        await model.fit(tf.tensor2d(features), tf.tensor2d(labels, [labels.length, 1]), {
            epochs: Math.min(50, data.length),
            batchSize: Math.min(32, Math.floor(data.length / 2)),
            validationSplit: 0.2,
            verbose: 0
        });
        
        console.log('✅ Model trained successfully');
        return true;
    } catch (err) {
        console.error('Training error:', err);
        return false;
    }
}

// Make prediction
async function makePrediction(targetDate) {
    if (!model || !normalizationParams.tempMean) {
        throw new Error('Model not ready - need to train first');
    }
    
    let recentData;
    if (useMemoryFallback) {
        recentData = temperatureData
            .filter(d => new Date(d.date_time) < targetDate)
            .sort((a, b) => new Date(b.date_time) - new Date(a.date_time))
            .slice(0, 5);
    } else {
        const result = await pool.request()
            .input('target_date', sql.DateTime2, targetDate)
            .query(`SELECT TOP 5 * FROM temperature_data WHERE date_time < @target_date ORDER BY date_time DESC`);
        recentData = result.recordset;
    }
    
    if (recentData.length === 0) throw new Error('No recent data available');
    
    const latest = recentData[0];
    const targetHour = new Date(targetDate).getHours();
    
    const features = [
        (latest.temperature - normalizationParams.tempMean) / normalizationParams.tempStd,
        latest.humidity / 100,
        (latest.pressure - 1013) / 50,
        latest.wind_speed / 30,
        latest.cloud_cover / 100,
        Math.sin(2 * Math.PI * targetHour / 24)
    ];
    
    const prediction = model.predict(tf.tensor2d([features]));
    const normalizedResult = await prediction.data();
    prediction.dispose();
    
    return {
        predicted_temperature: Math.round((normalizedResult[0] * normalizationParams.tempStd + normalizationParams.tempMean) * 10) / 10,
        confidence: 0.85,
        features_used: JSON.stringify({
            prev_temp: latest.temperature,
            humidity: latest.humidity,
            pressure: latest.pressure,
            wind_speed: latest.wind_speed,
            cloud_cover: latest.cloud_cover,
            hour_factor: Math.sin(2 * Math.PI * targetHour / 24)
        })
    };
}

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
    let stats;
    if (useMemoryFallback) {
        stats = { 
            total_records: temperatureData.length, 
            predictions: predictions.length,
            accuracy_records: predictionAccuracy.length
        };
    } else {
        try {
            const result = await pool.request().query(`
                SELECT 
                    (SELECT COUNT(*) FROM temperature_data) as total_records,
                    (SELECT COUNT(*) FROM predictions) as predictions,
                    (SELECT COUNT(*) FROM prediction_accuracy) as accuracy_records
            `);
            stats = result.recordset[0];
        } catch (err) {
            stats = { error: 'Database query failed' };
        }
    }
    
    res.json({
        status: 'healthy',
        database: useMemoryFallback ? 'in-memory' : 'strato_db',
        model: model ? 'loaded' : 'not_loaded',
        model_trained: normalizationParams.tempMean ? true : false,
        data_summary: stats,
        timestamp: new Date()
    });
});

// Get historical data
app.get('/api/temperature/historical', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        let result;
        
        if (useMemoryFallback) {
            result = temperatureData
                .sort((a, b) => new Date(b.date_time) - new Date(a.date_time))
                .slice(0, days * 4);
        } else {
            const dbResult = await pool.request()
                .input('days', sql.Int, days)
                .query(`SELECT TOP (@days * 4) * FROM temperature_data ORDER BY date_time DESC`);
            result = dbResult.recordset;
        }
        
        res.json(result.reverse());
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

// Add temperature data
app.post('/api/temperature', async (req, res) => {
    try {
        const { temperature, humidity, pressure, wind_speed, cloud_cover } = req.body;
        const dateTime = new Date();
        
        if (useMemoryFallback) {
            temperatureData.push({
                id: temperatureData.length + 1,
                date_time: dateTime.toISOString(),
                temperature, 
                humidity: humidity || 60, 
                pressure: pressure || 1013,
                wind_speed: wind_speed || 5, 
                cloud_cover: cloud_cover || 50,
                data_type: 'actual'
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('date_time', sql.DateTime2, dateTime)
                .input('temperature', sql.Float, temperature)
                .input('humidity', sql.Float, humidity || 60)
                .input('pressure', sql.Float, pressure || 1013)
                .input('wind_speed', sql.Float, wind_speed || 5)
                .input('cloud_cover', sql.Float, cloud_cover || 50)
                .query(`INSERT INTO temperature_data (date_time, temperature, humidity, pressure, wind_speed, cloud_cover) 
                        VALUES (@date_time, @temperature, @humidity, @pressure, @wind_speed, @cloud_cover)`);
        }
        
        res.json({ success: true, message: 'Data added successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add data' });
    }
});

// Make prediction
app.post('/api/predict/next-day', async (req, res) => {
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(12, 0, 0, 0);
        
        const prediction = await makePrediction(tomorrow);
        
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
                features_used: prediction.features_used,
                model_version: 'v1.0'
            });
            await saveMemoryData();
        } else {
            const result = await pool.request()
                .input('target_date', sql.DateTime2, tomorrow)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('confidence', sql.Float, prediction.confidence)
                .input('features_used', sql.Text, prediction.features_used)
                .query(`INSERT INTO predictions (target_date, predicted_temperature, confidence, features_used) 
                        OUTPUT INSERTED.id VALUES (@target_date, @predicted_temperature, @confidence, @features_used)`);
            predictionId = result.recordset[0].id;
        }
        
        res.json({
            success: true,
            prediction_id: predictionId,
            target_date: tomorrow,
            predicted_temperature: prediction.predicted_temperature,
            confidence: prediction.confidence,
            features_used: JSON.parse(prediction.features_used)
        });
    } catch (err) {
        res.status(500).json({ error: 'Prediction failed: ' + err.message });
    }
});

// Evaluate prediction and learn
app.post('/api/evaluate', async (req, res) => {
    try {
        const { prediction_id, actual_temperature } = req.body;
        
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
            return res.status(404).json({ error: 'Prediction not found' });
        }
        
        const error = Math.abs(actual_temperature - prediction.predicted_temperature);
        const percentageError = (error / Math.abs(actual_temperature)) * 100;
        
        // Save accuracy
        if (useMemoryFallback) {
            predictionAccuracy.push({
                id: predictionAccuracy.length + 1,
                prediction_id,
                actual_temperature,
                predicted_temperature: prediction.predicted_temperature,
                absolute_error: error,
                percentage_error: percentageError,
                evaluation_date: new Date().toISOString()
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('prediction_id', sql.Int, prediction_id)
                .input('actual_temperature', sql.Float, actual_temperature)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('absolute_error', sql.Float, error)
                .input('percentage_error', sql.Float, percentageError)
                .query(`INSERT INTO prediction_accuracy (prediction_id, actual_temperature, predicted_temperature, absolute_error, percentage_error) 
                        VALUES (@prediction_id, @actual_temperature, @predicted_temperature, @absolute_error, @percentage_error)`);
        }
        
        // Add actual data point for future training
        const targetDate = new Date(prediction.target_date);
        if (useMemoryFallback) {
            temperatureData.push({
                id: temperatureData.length + 1,
                date_time: targetDate.toISOString(),
                temperature: actual_temperature,
                humidity: 60, pressure: 1013, wind_speed: 5, cloud_cover: 50,
                data_type: 'correction'
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('date_time', sql.DateTime2, targetDate)
                .input('temperature', sql.Float, actual_temperature)
                .input('data_type', sql.VarChar, 'correction')
                .query(`INSERT INTO temperature_data (date_time, temperature, data_type) 
                        VALUES (@date_time, @temperature, @data_type)`);
        }
        
        // Auto-retrain if error is large
        let retraining = false;
        if (error > 2.0) {
            setTimeout(async () => {
                try {
                    await trainModel();
                    console.log('🔄 Model retrained due to large error');
                } catch (err) {
                    console.error('Retraining failed:', err);
                }
            }, 1000);
            retraining = true;
        }
        
        res.json({
            success: true,
            absolute_error: Math.round(error * 100) / 100,
            percentage_error: Math.round(percentageError * 100) / 100,
            accuracy_percentage: Math.round(Math.max(0, 100 - percentageError) * 100) / 100,
            auto_retrain_triggered: retraining
        });
    } catch (err) {
        res.status(500).json({ error: 'Evaluation failed: ' + err.message });
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
        
        // Calculate analytics
        const analytics = {
            total_data_points: data.length,
            total_predictions: accuracyData.length,
            average_error: accuracyData.length > 0 ? 
                accuracyData.reduce((sum, a) => sum + a.absolute_error, 0) / accuracyData.length : 0,
            best_prediction: accuracyData.length > 0 ? 
                Math.min(...accuracyData.map(a => a.absolute_error)) : 0,
            worst_prediction: accuracyData.length > 0 ? 
                Math.max(...accuracyData.map(a => a.absolute_error)) : 0,
            recent_accuracy: accuracyData.slice(-5).length > 0 ?
                accuracyData.slice(-5).reduce((sum, a) => sum + (100 - a.percentage_error), 0) / accuracyData.slice(-5).length : 0,
            data_sources: {
                actual: data.filter(d => d.data_type === 'actual').length,
                corrections: data.filter(d => d.data_type === 'correction').length
            }
        };
        
        res.json(analytics);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch analytics' });
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
    } catch (err) {
        res.status(500).json({ error: 'Retraining failed' });
    }
});

// Get current weather data
app.get('/api/weather/current', async (req, res) => {
    try {
        const weatherData = await fetchWeatherData();
        res.json({
            success: true,
            data: weatherData,
            timestamp: new Date()
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            configured: !!WEATHER_API_KEY
        });
    }
});

// Manually trigger weather data save
app.post('/api/weather/save', async (req, res) => {
    try {
        const weatherData = await updateWeatherData();
        if (weatherData) {
            res.json({
                success: true,
                message: 'Weather data saved successfully',
                data: weatherData
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to fetch or save weather data'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get weather configuration status
app.get('/api/weather/status', (req, res) => {
    res.json({
        configured: !!WEATHER_API_KEY,
        city: WEATHER_CITY,
        auto_updates: !!weatherUpdateInterval,
        last_update: new Date() // This would be stored in a real implementation
    });
});
app.get('/api/predictions/recent', async (req, res) => {
    try {
        let recentPredictions;
        
        if (useMemoryFallback) {
            recentPredictions = predictions
                .sort((a, b) => new Date(b.prediction_date) - new Date(a.prediction_date))
                .slice(0, 10)
                .map(pred => {
                    const accuracy = predictionAccuracy.find(acc => acc.prediction_id === pred.id);
                    return {
                        ...pred,
                        actual_temperature: accuracy ? accuracy.actual_temperature : null,
                        absolute_error: accuracy ? accuracy.absolute_error : null,
                        status: accuracy ? 'evaluated' : 'pending'
                    };
                });
        } else {
            const result = await pool.request().query(`
                SELECT TOP 10 
                    p.*,
                    pa.actual_temperature,
                    pa.absolute_error,
                    CASE WHEN pa.id IS NULL THEN 'pending' ELSE 'evaluated' END as status
                FROM predictions p
                LEFT JOIN prediction_accuracy pa ON p.id = pa.prediction_id
                ORDER BY p.prediction_date DESC
            `);
            recentPredictions = result.recordset;
        }
        
        res.json(recentPredictions);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch predictions' });
    }
});

// Enhanced web interface - serve static file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback route for missing index.html
app.get('/dashboard', (req, res) => {
    res.send('<h1>Please create public/index.html file</h1><p>The frontend should be in public/index.html</p>');
});

// Start server
async function startServer() {
    try {
        console.log('Starting Temperature Prediction System...');
        
        await initDB();
        await createModel();
        
        const trained = await trainModel();
        if (trained) {
            console.log('Model trained successfully');
        } else {
            console.log('Model ready - add data to train');
        }
        
        app.listen(PORT, () => {
            console.log(`\nServer running on port ${PORT}`);
            console.log(`Database: ${useMemoryFallback ? 'In-Memory' : 'Azure SQL (strato_db)'}`);
            console.log(`AI Model: ${model ? 'Ready' : 'Loading...'}`);
            console.log(`Dashboard: http://localhost:${PORT}`);
            console.log(`Health: http://localhost:${PORT}/api/health`);
        });
        
    } catch (err) {
        console.error('Failed to start server:', err.message);
        process.exit(1);
    }
}
startServer();
startWeatherUpdates();

//