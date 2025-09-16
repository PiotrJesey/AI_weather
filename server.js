const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

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
        await generateDummyData();
        return true;
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        
        if (process.env.ENABLE_MEMORY_FALLBACK === 'true') {
            console.log('🔄 Using in-memory fallback...');
            useMemoryFallback = true;
            await loadMemoryData();
            await generateMemoryData();
            return true;
        }
        throw err;
    }
}

// Create database tables
async function createTables() {
    try {
        console.log('🔍 Checking existing tables...');
        
        // Check which tables exist
        const existingTables = await pool.request().query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_TYPE = 'BASE TABLE'
        `);
        
        const tableNames = existingTables.recordset.map(row => row.TABLE_NAME.toLowerCase());
        console.log('📋 Existing tables:', tableNames.join(', ') || 'none');
        
        // Create temperature_data table if it doesn't exist
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
            console.log('✅ Created temperature_data table');
        } else {
            console.log('📊 temperature_data table already exists');
        }
        
        // Create predictions table if it doesn't exist
        if (!tableNames.includes('predictions')) {
            await pool.request().query(`
                CREATE TABLE predictions (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    prediction_date DATETIME2 DEFAULT GETDATE(),
                    target_date DATETIME2 NOT NULL,
                    predicted_temperature FLOAT NOT NULL,
                    confidence FLOAT DEFAULT 0.8,
                    features_used TEXT
                )
            `);
            console.log('✅ Created predictions table');
        } else {
            console.log('🔮 predictions table already exists');
        }
        
        // Create prediction_accuracy table if it doesn't exist
        if (!tableNames.includes('prediction_accuracy')) {
            await pool.request().query(`
                CREATE TABLE prediction_accuracy (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    prediction_id INT NOT NULL,
                    actual_temperature FLOAT NOT NULL,
                    predicted_temperature FLOAT NOT NULL,
                    absolute_error FLOAT NOT NULL,
                    evaluation_date DATETIME2 DEFAULT GETDATE()
                )
            `);
            console.log('✅ Created prediction_accuracy table');
        } else {
            console.log('📈 prediction_accuracy table already exists');
        }
        
        console.log('✅ Database tables ready');
    } catch (err) {
        console.error('❌ Error with database tables:', err.message);
        throw err;
    }
}

// Generate dummy data
async function generateDummyData() {
    try {
        let count = 0;
        
        if (useMemoryFallback) {
            count = temperatureData.length;
        } else {
            const result = await pool.request().query('SELECT COUNT(*) as count FROM temperature_data');
            count = result.recordset[0].count;
        }
        
        if (count >= 100) {
            console.log(`📊 Database already has ${count} records, skipping dummy data generation`);
            return;
        }
        
        console.log('📊 Generating 400 days of temperature data...');
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 400);
        
        let recordsAdded = 0;
        
        for (let i = 0; i < 400; i++) {
            const date = new Date(startDate);
            date.setDate(date.getDate() + i);
            
            // Generate 4 readings per day
            for (let hour = 0; hour < 24; hour += 6) {
                const currentDate = new Date(date);
                currentDate.setHours(hour, 0, 0, 0);
                
                const dayOfYear = Math.floor((currentDate - new Date(currentDate.getFullYear(), 0, 0)) / 86400000);
                const temp = 15 + 10 * Math.sin(2 * Math.PI * (dayOfYear - 80) / 365) + 
                            3 * Math.sin(2 * Math.PI * (hour - 6) / 24) + (Math.random() - 0.5) * 4;
                const humidity = Math.max(20, Math.min(95, 70 - (temp - 15) * 1.5 + (Math.random() - 0.5) * 20));
                const pressure = 1013 + Math.sin(2 * Math.PI * dayOfYear / 365) * 10 + (Math.random() - 0.5) * 15;
                
                if (useMemoryFallback) {
                    temperatureData.push({
                        id: temperatureData.length + 1,
                        date_time: currentDate.toISOString(),
                        temperature: Math.round(temp * 10) / 10,
                        humidity: Math.round(humidity * 10) / 10,
                        pressure: Math.round(pressure * 10) / 10,
                        wind_speed: Math.round((5 + Math.random() * 10) * 10) / 10,
                        cloud_cover: Math.round((Math.random() * 100) * 10) / 10,
                        data_type: 'actual'
                    });
                } else {
                    try {
                        await pool.request()
                            .input('date_time', sql.DateTime2, currentDate)
                            .input('temperature', sql.Float, Math.round(temp * 10) / 10)
                            .input('humidity', sql.Float, Math.round(humidity * 10) / 10)
                            .input('pressure', sql.Float, Math.round(pressure * 10) / 10)
                            .input('wind_speed', sql.Float, Math.round((5 + Math.random() * 10) * 10) / 10)
                            .input('cloud_cover', sql.Float, Math.round((Math.random() * 100) * 10) / 10)
                            .query(`INSERT INTO temperature_data (date_time, temperature, humidity, pressure, wind_speed, cloud_cover) 
                                    VALUES (@date_time, @temperature, @humidity, @pressure, @wind_speed, @cloud_cover)`);
                        recordsAdded++;
                    } catch (insertError) {
                        // Skip duplicate entries or other insert errors
                        if (insertError.message.includes('duplicate') || insertError.message.includes('UNIQUE')) {
                            continue;
                        } else {
                            throw insertError;
                        }
                    }
                }
            }
            
            // Show progress every 50 days
            if ((i + 1) % 50 === 0) {
                console.log(`📈 Progress: ${i + 1}/400 days processed...`);
            }
        }
        
        if (useMemoryFallback) {
            await saveMemoryData();
            console.log(`✅ Generated ${temperatureData.length} records in memory`);
        } else {
            console.log(`✅ Generated ${recordsAdded} new temperature records`);
        }
    } catch (err) {
        console.error('❌ Error generating dummy data:', err.message);
        // Don't throw error - continue with existing data
        console.log('⚠️ Continuing with existing data...');
    }
}

// Memory data management
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

async function generateMemoryData() {
    if (temperatureData.length >= 100) return;
    await generateDummyData();
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
        
        if (data.length < 50) return false;
        
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
            epochs: 50,
            batchSize: 32,
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
        throw new Error('Model not ready');
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
    
    if (recentData.length === 0) throw new Error('No recent data');
    
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
        confidence: 0.85
    };
}

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
    const stats = useMemoryFallback ? 
        { total_records: temperatureData.length, predictions: predictions.length } :
        await pool.request().query('SELECT COUNT(*) as total_records FROM temperature_data').then(r => r.recordset[0]);
    
    res.json({
        status: 'healthy',
        database: useMemoryFallback ? 'in-memory' : 'strato_db',
        model: model ? 'loaded' : 'not_loaded',
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
                temperature, humidity: humidity || 60, pressure: pressure || 1013,
                wind_speed: wind_speed || 5, cloud_cover: cloud_cover || 50,
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
                confidence: prediction.confidence
            });
            await saveMemoryData();
        } else {
            const result = await pool.request()
                .input('target_date', sql.DateTime2, tomorrow)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('confidence', sql.Float, prediction.confidence)
                .query(`INSERT INTO predictions (target_date, predicted_temperature, confidence) 
                        OUTPUT INSERTED.id VALUES (@target_date, @predicted_temperature, @confidence)`);
            predictionId = result.recordset[0].id;
        }
        
        res.json({
            success: true,
            prediction_id: predictionId,
            target_date: tomorrow,
            ...prediction
        });
    } catch (err) {
        res.status(500).json({ error: 'Prediction failed: ' + err.message });
    }
});

// Evaluate prediction
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
        
        // Save accuracy
        if (useMemoryFallback) {
            predictionAccuracy.push({
                id: predictionAccuracy.length + 1,
                prediction_id,
                actual_temperature,
                predicted_temperature: prediction.predicted_temperature,
                absolute_error: error,
                evaluation_date: new Date().toISOString()
            });
            await saveMemoryData();
        } else {
            await pool.request()
                .input('prediction_id', sql.Int, prediction_id)
                .input('actual_temperature', sql.Float, actual_temperature)
                .input('predicted_temperature', sql.Float, prediction.predicted_temperature)
                .input('absolute_error', sql.Float, error)
                .query(`INSERT INTO prediction_accuracy (prediction_id, actual_temperature, predicted_temperature, absolute_error) 
                        VALUES (@prediction_id, @actual_temperature, @predicted_temperature, @absolute_error)`);
        }
        
        // Retrain if large error
        if (error > 3.0) {
            setTimeout(() => trainModel(), 1000);
        }
        
        res.json({
            success: true,
            absolute_error: Math.round(error * 100) / 100,
            accuracy_percentage: Math.round(Math.max(0, 100 - error * 10) * 100) / 100
        });
    } catch (err) {
        res.status(500).json({ error: 'Evaluation failed' });
    }
});

// Retrain model
app.post('/api/retrain', async (req, res) => {
    try {
        const success = await trainModel();
        res.json({ 
            success, 
            message: success ? 'Model retrained successfully' : 'Training failed - insufficient data'
        });
    } catch (err) {
        res.status(500).json({ error: 'Retraining failed' });
    }
});

// Simple web interface
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>🌡️ AI Temperature Prediction - strato_db</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            .card { background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .status { background: linear-gradient(45deg, #28a745, #20c997); color: white; text-align: center; }
            button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
            button:hover { background: #0056b3; }
            input { padding: 8px; margin: 5px; border: 1px solid #ddd; border-radius: 4px; }
        </style>
        </head>
        <body>
            <div class="card status">
                <h1>🌡️ AI Temperature Prediction System</h1>
                <p><strong>Database:</strong> ${useMemoryFallback ? 'In-Memory Storage' : 'Azure SQL (strato_db)'}</p>
                <p><strong>Status:</strong> ${model ? '✅ AI Model Ready' : '⏳ Training...'}</p>
            </div>
            
            <div class="card">
                <h3>🎯 Make Prediction</h3>
                <button onclick="predict()">Predict Tomorrow's Temperature</button>
                <div id="prediction"></div>
            </div>
            
            <div class="card">
                <h3>📊 Add Temperature Data</h3>
                <input type="number" id="temp" placeholder="Temperature (°C)" step="0.1">
                <input type="number" id="humidity" placeholder="Humidity (%)" step="0.1">
                <input type="number" id="pressure" placeholder="Pressure (hPa)" step="0.1">
                <button onclick="addData()">Add Data</button>
            </div>
            
            <script>
                async function predict() {
                    document.getElementById('prediction').innerHTML = '🔄 Making prediction...';
                    try {
                        const res = await fetch('/api/predict/next-day', { method: 'POST' });
                        const data = await res.json();
                        document.getElementById('prediction').innerHTML = 
                            '<h4>Tomorrow: ' + data.predicted_temperature + '°C</h4>' +
                            '<p>Confidence: ' + Math.round(data.confidence * 100) + '%</p>' +
                            '<p>Prediction ID: #' + data.prediction_id + '</p>';
                    } catch (err) {
                        document.getElementById('prediction').innerHTML = '❌ Error: ' + err.message;
                    }
                }
                
                async function addData() {
                    const temp = document.getElementById('temp').value;
                    const humidity = document.getElementById('humidity').value;
                    const pressure = document.getElementById('pressure').value;
                    
                    if (!temp) return alert('Temperature is required');
                    
                    try {
                        const res = await fetch('/api/temperature', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                temperature: parseFloat(temp),
                                humidity: parseFloat(humidity) || null,
                                pressure: parseFloat(pressure) || null
                            })
                        });
                        
                        if (res.ok) {
                            alert('✅ Data added successfully!');
                            document.getElementById('temp').value = '';
                            document.getElementById('humidity').value = '';
                            document.getElementById('pressure').value = '';
                        }
                    } catch (err) {
                        alert('❌ Error adding data');
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Start server
async function startServer() {
    try {
        console.log('🌡️ Starting Temperature Prediction System...');
        
        await initDB();
        await createModel();
        
        const trained = await trainModel();
        if (trained) {
            console.log('🎯 Model trained successfully');
        } else {
            console.log('⚠️ Model training incomplete - insufficient data');
        }
        
        app.listen(PORT, () => {
            console.log(`\n🚀 Server running on port ${PORT}`);
            console.log(`🗄️ Database: ${useMemoryFallback ? 'In-Memory' : 'Azure SQL (strato_db)'}`);
            console.log(`🧠 AI Model: ${model ? 'Ready' : 'Loading...'}`);
            console.log(`🌐 Dashboard: http://localhost:${PORT}`);
            console.log(`🔍 Health: http://localhost:${PORT}/api/health`);
        });
        
    } catch (err) {
        console.error('❌ Failed to start server:', err.message);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down...');
    if (useMemoryFallback) await saveMemoryData();
    if (pool) await pool.close();
    console.log('✅ Shutdown complete');
    process.exit(0);
});

// Auto-save for memory mode
if (process.env.NODE_ENV !== 'production') {
    setInterval(() => {
        if (useMemoryFallback) saveMemoryData();
    }, 5 * 60 * 1000);
}

startServer();