// 14-day prediction - Updated to save predictions to database
app.post('/api/predict/14-day', async (req, res) => {
    try {
        const results = [];
        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        startDate.setHours(12, 0, 0, 0);
        
        const predictionDate = new Date(); // Common prediction timestamp
        let savedPredictions = [];
        
        for (let day = 1; day <= 14; day++) {
            const targetDate = new Date(startDate);
            targetDate.setDate(startDate.getDate() + day - 1);
            
            const prediction = await makePrediction(targetDate, day);
            
            // Save each prediction to database
            let predictionId;
            if (useMemoryFallback) {
                predictionId = predictions.length + 1;
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
                const result = await pool.request()
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
                predictionId = result.recordset[0].id;
                savedPredictions.push({
                    id: predictionId,
                    prediction_date: predictionDate,
                    target_date: targetDate,
                    predicted_temperature: prediction.predicted_temperature,
                    confidence: prediction.confidence,
                    prediction_type: '14-day',
                    days_ahead: day
                });
            }
            
            results.push({
                prediction_id: predictionId,
                day: day,
                date: targetDate.toISOString().split('T')[0],
                predicted_temperature: prediction.predicted_temperature,
                confidence: Math.round(prediction.confidence * 100)
            });
        }
        
        // Save memory data if using fallback
        if (useMemoryFallback) {
            await saveMemoryData();
        }
        
        res.json({
            success: true,
            message: `Successfully created and saved 14-day forecast`,
            prediction_batch_date: predictionDate,
            predictions: results,
            total_predictions: results.length,
            saved_to_database: true,
            database_type: useMemoryFallback ? 'in-memory' : 'azure-sql'
        });
    } catch (error) {
        console.error('14-day prediction error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});