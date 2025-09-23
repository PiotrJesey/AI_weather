// Enhanced AI Temperature Prediction System - Frontend JavaScript with Debug & Manual Historic Valuation
let temperatureChart, predictionChart;
let currentPredictionId = null;

// Initialize app with debug logging
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing app...');
    
    // Check if required elements exist
    const requiredElements = [
        'status-text', 'weather-display', 'predictions-list', 
        'temperature-chart', 'prediction-chart'
    ];
    
    const missingElements = requiredElements.filter(id => !document.getElementById(id));
    if (missingElements.length > 0) {
        console.error('Missing required elements:', missingElements);
        return;
    }
    
    updateSystemStatus();
    loadAnalytics();
    loadRecentPredictions();
    loadPendingEvaluations();
    initCharts();
    getCurrentWeather();
    
    // Auto-refresh with debug logging
    setInterval(() => {
        console.log('Auto-refreshing system status...');
        updateSystemStatus();
    }, 30000);
    
    setInterval(() => {
        console.log('Auto-refreshing weather...');
        getCurrentWeather();
    }, 10 * 60 * 1000);
    
    console.log('App initialization complete');
});

// Enhanced system status with debug
async function updateSystemStatus() {
    console.log('Updating system status...');
    try {
        const response = await fetch('/api/health');
        console.log('Health API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Health API data:', data);
        
        const statusEl = document.getElementById('status-text');
        if (!statusEl) {
            console.error('status-text element not found');
            return;
        }
        
        const dbType = data.database === 'in-memory' ? 'Local Storage' : 'Azure SQL';
        const modelStatus = data.model_trained ? 'Trained & Ready' : 'Ready (Need Data)';
        const autoStatus = data.auto_comparison ? '🤖 Auto-Compare ON' : '❌ Auto-Compare OFF';
        
        statusEl.innerHTML = `
            ${data.status === 'healthy' ? '✅' : '❌'} ${dbType} | 
            🧠 ${modelStatus} | 
            ${autoStatus} | 
            📊 ${data.data_summary.total_records || 0} Records
        `;
        
        console.log('System status updated successfully');
    } catch (error) {
        console.error('System status update failed:', error);
        const statusEl = document.getElementById('status-text');
        if (statusEl) {
            statusEl.innerHTML = `❌ Connection Error: ${error.message}`;
        }
    }
}

// Show message helper with debug
function showMessage(elementId, message, type = 'success') {
    console.log(`Showing message in ${elementId}:`, message, type);
    const el = document.getElementById(elementId);
    if (!el) {
        console.error(`Element ${elementId} not found for message display`);
        return;
    }
    el.className = `result ${type}`;
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

// Enhanced analytics with debug
async function loadAnalytics() {
    console.log('Loading analytics...');
    try {
        const response = await fetch('/api/analytics');
        console.log('Analytics API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Analytics data:', data);

        // Check if elements exist before updating
        const elements = {
            'total-predictions': data.total_predictions || 0,
            'avg-error': data.average_error ? data.average_error.toFixed(2) + '°C' : '0°C',
            'accuracy': data.recent_accuracy ? Math.round(data.recent_accuracy) + '%' : '0%',
            'auto-evals': data.auto_evaluations || 0,
            'manual-evals': data.manual_evaluations || 0,
            'pending-evals': data.pending_evaluations || 0
        };
        
        Object.entries(elements).forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = value;
                console.log(`Updated ${id} with value:`, value);
            } else {
                console.warn(`Element ${id} not found`);
            }
        });
        
        console.log('Analytics loaded successfully');
    } catch (error) {
        console.error('Failed to load analytics:', error);
        showMessage('prediction-result', `Analytics error: ${error.message}`, 'error');
    }
}

// Load recent predictions with enhanced debug
async function loadRecentPredictions() {
    console.log('Loading recent predictions...');
    try {
        const response = await fetch('/api/predictions/recent');
        console.log('Recent predictions API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Recent predictions data:', data);

        const listEl = document.getElementById('predictions-list');
        if (!listEl) {
            console.error('predictions-list element not found');
            return;
        }
        
        if (!Array.isArray(data)) {
            console.error('Expected array for predictions data, got:', typeof data);
            listEl.innerHTML = '<div class="loading">Invalid data format received</div>';
            return;
        }
        
        if (data.length === 0) {
            listEl.innerHTML = '<div class="loading">No predictions yet. Make your first prediction!</div>';
            console.log('No predictions found');
            return;
        }

        listEl.innerHTML = data.map((pred, index) => {
            console.log(`Processing prediction ${index}:`, pred);
            
            const date = pred.prediction_date ? new Date(pred.prediction_date).toLocaleDateString() : 'Unknown';
            const targetDate = pred.target_date ? new Date(pred.target_date).toLocaleDateString() : 'Unknown';
            const evalType = pred.evaluation_type ? `(${pred.evaluation_type})` : '';
            
            // Add evaluate button for unevaluated predictions where target date has passed
            const targetDateObj = pred.target_date ? new Date(pred.target_date) : null;
            const canEvaluate = targetDateObj && targetDateObj <= new Date() && !pred.actual_temperature;
            
            return `
                <div class="prediction-item ${pred.status || 'unknown'}">
                    <div>
                        <strong>#${pred.id || 'N/A'}</strong> ${pred.predicted_temperature || 'N/A'}°C for ${targetDate}
                        <br><small>Made: ${date} | Type: ${pred.prediction_type || 'single'} ${evalType}</small>
                        ${pred.actual_temperature ? 
                            `<br><small>Actual: ${pred.actual_temperature}°C | Error: ${pred.absolute_error?.toFixed(2) || 'N/A'}°C</small>` : 
                            '<br><small>Awaiting evaluation</small>'
                        }
                        ${canEvaluate ? `
                            <div class="evaluation-controls" style="margin-top: 8px;">
                                <input type="number" id="actual-temp-${pred.id}" step="0.1" placeholder="Actual temp" style="width: 80px; margin-right: 5px;">
                                <button onclick="evaluatePrediction(${pred.id})" class="btn-mini">Evaluate</button>
                            </div>
                        ` : ''}
                    </div>
                    <span class="status-badge ${pred.status || 'unknown'}">${(pred.status || 'UNKNOWN').toUpperCase()}</span>
                </div>
            `;
        }).join('');
        
        console.log(`Loaded ${data.length} predictions successfully`);
    } catch (error) {
        console.error('Failed to load recent predictions:', error);
        const listEl = document.getElementById('predictions-list');
        if (listEl) {
            listEl.innerHTML = `<div class="loading">Failed to load predictions: ${error.message}</div>`;
        }
    }
}

// NEW: Load predictions pending manual evaluation
async function loadPendingEvaluations() {
    console.log('Loading pending evaluations...');
    try {
        const response = await fetch('/api/predictions/pending-evaluation');
        console.log('Pending evaluations API response status:', response.status);
        
        if (!response.ok) {
            console.warn('Pending evaluations endpoint not available');
            return;
        }
        
        const data = await response.json();
        console.log('Pending evaluations data:', data);

        const listEl = document.getElementById('pending-evaluations-list');
        if (!listEl) {
            console.warn('pending-evaluations-list element not found - creating dynamic section');
            createPendingEvaluationsSection();
            return;
        }
        
        if (!Array.isArray(data) || data.length === 0) {
            listEl.innerHTML = '<div class="no-pending">No predictions pending evaluation</div>';
            return;
        }

        listEl.innerHTML = data.map(pred => {
            const targetDate = new Date(pred.target_date).toLocaleDateString();
            const predDate = new Date(pred.prediction_date).toLocaleDateString();
            const daysOverdue = Math.floor((new Date() - new Date(pred.target_date)) / (1000 * 60 * 60 * 24));
            
            return `
                <div class="pending-evaluation-item">
                    <div class="prediction-info">
                        <strong>Prediction #${pred.id}</strong>
                        <div class="prediction-details">
                            <div>Predicted: <strong>${pred.predicted_temperature}°C</strong> for ${targetDate}</div>
                            <div>Made: ${predDate} | Confidence: ${Math.round(pred.confidence * 100)}%</div>
                            <div class="overdue-info">⚠️ ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue</div>
                        </div>
                    </div>
                    <div class="evaluation-form">
                        <input 
                            type="number" 
                            id="eval-temp-${pred.id}" 
                            step="0.1" 
                            placeholder="Actual temperature"
                            class="temp-input"
                        >
                        <button onclick="evaluatePrediction(${pred.id})" class="btn-evaluate">
                            ✓ Evaluate
                        </button>
                    </div>
                </div>
            `;
        }).join('');
        
        console.log(`Loaded ${data.length} pending evaluations`);
    } catch (error) {
        console.error('Failed to load pending evaluations:', error);
    }
}

// NEW: Create pending evaluations section if it doesn't exist
function createPendingEvaluationsSection() {
    // This would be called if the HTML doesn't have the pending evaluations section
    // You can add this dynamically or just log that it's missing
    console.log('Pending evaluations section should be added to HTML');
}

// NEW: Evaluate a specific prediction manually
async function evaluatePrediction(predictionId) {
    console.log(`Manually evaluating prediction ${predictionId}...`);
    
    // Try to find the temperature input in multiple possible locations
    let tempInput = document.getElementById(`eval-temp-${predictionId}`) || 
                   document.getElementById(`actual-temp-${predictionId}`);
    
    if (!tempInput) {
        showMessage('evaluation-result', 'Temperature input not found', 'error');
        return;
    }
    
    const actualTemp = parseFloat(tempInput.value);
    
    if (isNaN(actualTemp)) {
        showMessage('evaluation-result', 'Please enter a valid temperature', 'error');
        tempInput.focus();
        return;
    }
    
    if (actualTemp < -50 || actualTemp > 60) {
        showMessage('evaluation-result', 'Temperature seems unrealistic (-50°C to 60°C expected)', 'error');
        tempInput.focus();
        return;
    }

    try {
        const response = await fetch(`/api/predictions/${predictionId}/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                actual_temperature: actualTemp,
                evaluation_type: 'manual'
            })
        });

        console.log('Evaluation API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('Evaluation result:', result);

        if (result.success) {
            const error = Math.abs(result.predicted_temperature - actualTemp).toFixed(2);
            showMessage('evaluation-result', 
                `✅ Prediction #${predictionId} evaluated: ${error}°C error (${result.accuracy_category})`, 
                'success'
            );
            
            // Clear the input
            tempInput.value = '';
            
            // Refresh all relevant displays
            loadRecentPredictions();
            loadPendingEvaluations();
            loadAnalytics();
            
            // Update chart if it exists
            if (typeof loadCombinedChart === 'function') {
                loadCombinedChart();
            }
            
        } else {
            showMessage('evaluation-result', result.error || 'Evaluation failed', 'error');
        }
    } catch (error) {
        console.error('Evaluation failed:', error);
        showMessage('evaluation-result', `Evaluation error: ${error.message}`, 'error');
    }
}

// NEW: Bulk evaluate multiple predictions
async function bulkEvaluatePredictions() {
    console.log('Starting bulk evaluation...');
    
    const evaluationInputs = document.querySelectorAll('[id^="eval-temp-"]:not(:empty), [id^="actual-temp-"]:not(:empty)');
    
    if (evaluationInputs.length === 0) {
        showMessage('evaluation-result', 'No evaluations to process', 'warning');
        return;
    }
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const input of evaluationInputs) {
        if (!input.value) continue;
        
        const predictionId = input.id.replace(/^(eval-temp-|actual-temp-)/, '');
        const actualTemp = parseFloat(input.value);
        
        if (isNaN(actualTemp)) {
            errorCount++;
            continue;
        }
        
        try {
            const response = await fetch(`/api/predictions/${predictionId}/evaluate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    actual_temperature: actualTemp,
                    evaluation_type: 'manual_bulk'
                })
            });
            
            if (response.ok) {
                successCount++;
                input.value = ''; // Clear successful evaluations
            } else {
                errorCount++;
            }
        } catch (error) {
            console.error(`Bulk evaluation failed for prediction ${predictionId}:`, error);
            errorCount++;
        }
    }
    
    showMessage('evaluation-result', 
        `Bulk evaluation complete: ${successCount} successful, ${errorCount} failed`, 
        errorCount === 0 ? 'success' : 'warning'
    );
    
    // Refresh displays
    loadRecentPredictions();
    loadPendingEvaluations();
    loadAnalytics();
}

// Enhanced weather functions with debug
async function getCurrentWeather() {
    console.log('Getting current weather...');
    try {
        const response = await fetch('/api/weather/current');
        console.log('Weather API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('Weather API result:', result);
        
        const weatherDisplay = document.getElementById('weather-display');
        if (!weatherDisplay) {
            console.error('weather-display element not found');
            return;
        }
        
        if (result.success && result.data) {
            const data = result.data;
            weatherDisplay.innerHTML = `
                <div class="weather-info">
                    <div class="weather-main">
                        <span class="weather-temp">${data.temperature}°C</span>
                        <span class="weather-location">${data.city}, ${data.country}</span>
                    </div>
                    <div class="weather-details">
                        <div class="weather-item">
                            <span class="weather-label">Humidity:</span>
                            <span class="weather-value">${data.humidity}%</span>
                        </div>
                        <div class="weather-item">
                            <span class="weather-label">Pressure:</span>
                            <span class="weather-value">${data.pressure} hPa</span>
                        </div>
                        <div class="weather-item">
                            <span class="weather-label">Wind:</span>
                            <span class="weather-value">${data.wind_speed} km/h</span>
                        </div>
                        <div class="weather-item">
                            <span class="weather-label">Clouds:</span>
                            <span class="weather-value">${data.cloud_cover}%</span>
                        </div>
                    </div>
                    <div class="weather-timestamp">
                        Updated: ${new Date(data.timestamp).toLocaleTimeString()}
                    </div>
                </div>
            `;
            
            // Auto-populate form
            updateFormFields({
                temp: Math.round(data.temperature * 10) / 10,
                humidity: Math.round(data.humidity),
                pressure: Math.round(data.pressure),
                wind_speed: Math.round(data.wind_speed * 10) / 10,
                cloud_cover: Math.round(data.cloud_cover)
            });
            
        } else if (result.fallback) {
            console.log('Using fallback weather data');
            const data = result.fallback;
            weatherDisplay.innerHTML = `
                <div class="weather-info" style="border: 2px dashed rgba(255,255,255,0.5);">
                    <div class="weather-main">
                        <span class="weather-temp">${Math.round(data.temperature * 10) / 10}°C</span>
                        <span class="weather-location">${data.city} (Demo Mode)</span>
                    </div>
                    <div class="weather-details">
                        <div class="weather-item">
                            <span class="weather-label">Humidity:</span>
                            <span class="weather-value">${Math.round(data.humidity)}%</span>
                        </div>
                        <div class="weather-item">
                            <span class="weather-label">Pressure:</span>
                            <span class="weather-value">${Math.round(data.pressure)} hPa</span>
                        </div>
                        <div class="weather-item">
                            <span class="weather-label">Wind:</span>
                            <span class="weather-value">${Math.round(data.wind_speed * 10) / 10} km/h</span>
                        </div>
                        <div class="weather-item">
                            <span class="weather-label">Clouds:</span>
                            <span class="weather-value">${Math.round(data.cloud_cover)}%</span>
                        </div>
                    </div>
                    <div class="weather-timestamp">
                        Demo data - ${result.configured ? 'API Error' : 'No API Key'}: ${result.error || 'Using simulated values'}
                    </div>
                </div>
            `;
            
            updateFormFields({
                temp: Math.round(data.temperature * 10) / 10,
                humidity: Math.round(data.humidity),
                pressure: Math.round(data.pressure),
                wind_speed: Math.round(data.wind_speed * 10) / 10,
                cloud_cover: Math.round(data.cloud_cover)
            });
            
        } else {
            console.log('Weather API failed, showing error');
            weatherDisplay.innerHTML = `
                <div class="weather-error">
                    <p>Weather data unavailable</p>
                    <small>${result.error || 'Unknown error'}</small>
                    <p><small>Get your free API key from <a href="https://openweathermap.org/api" target="_blank">OpenWeatherMap</a></small></p>
                </div>
            `;
        }
        
        console.log('Weather data loaded successfully');
    } catch (error) {
        console.error('Weather loading failed:', error);
        const weatherDisplay = document.getElementById('weather-display');
        if (weatherDisplay) {
            weatherDisplay.innerHTML = `
                <div class="weather-error">
                    <p>Failed to load weather data</p>
                    <small>Connection error: ${error.message}</small>
                    <p><small>Using default values for testing</small></p>
                </div>
            `;
        }
        
        // Provide default values when everything fails
        updateFormFields({
            temp: '20.0',
            humidity: '60',
            pressure: '1013',
            wind_speed: '10',
            cloud_cover: '30'
        });
    }
}

// Helper function to update form fields safely
function updateFormFields(data) {
    Object.entries(data).forEach(([field, value]) => {
        const element = document.getElementById(field);
        if (element) {
            element.value = value;
            console.log(`Updated ${field} field with:`, value);
        } else {
            console.warn(`Form field ${field} not found`);
        }
    });
}

// Initialize enhanced charts with debug
function initCharts() {
    console.log('Initializing charts...');
    
    // Check if chart elements exist
    const tempCanvas = document.getElementById('temperature-chart');
    const predCanvas = document.getElementById('prediction-chart');
    
    if (!tempCanvas) {
        console.error('temperature-chart canvas not found');
        return;
    }
    
    if (!predCanvas) {
        console.error('prediction-chart canvas not found');
        return;
    }
    
    try {
        // Historical temperature chart
        const ctx1 = tempCanvas.getContext('2d');
        temperatureChart = new Chart(ctx1, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Temperature (°C)',
                    data: [],
                    borderColor: 'rgb(102, 126, 234)',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: false,
                        title: { display: true, text: 'Temperature (°C)' }
                    }
                }
            }
        });
        console.log('Temperature chart initialized');

        // Combined chart for predictions
        const ctx2 = predCanvas.getContext('2d');
        predictionChart = new Chart(ctx2, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Historical',
                        data: [],
                        borderColor: 'rgb(102, 126, 234)',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        borderWidth: 3,
                        fill: false
                    },
                    {
                        label: 'Predictions',
                        data: [],
                        borderColor: 'rgb(239, 68, 68)',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        borderWidth: 3,
                        borderDash: [5, 5],
                        fill: false
                    },
                    {
                        label: 'Evaluated',
                        data: [],
                        borderColor: 'rgb(34, 197, 94)',
                        backgroundColor: 'rgba(34, 197, 94, 0.1)',
                        borderWidth: 3,
                        pointStyle: 'triangle',
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: false,
                        title: { display: true, text: 'Temperature (°C)' }
                    }
                },
                plugins: {
                    title: { display: true, text: 'Historical Data vs Predictions vs Evaluations' }
                }
            }
        });
        console.log('Prediction chart initialized');
        
        loadCombinedChart();
        loadHistoricalData();
        
    } catch (error) {
        console.error('Chart initialization failed:', error);
        showMessage('prediction-result', `Chart error: ${error.message}`, 'error');
    }
}

// Load combined historical and prediction data with debug
async function loadCombinedChart() {
    console.log('Loading combined chart data...');
    try {
        const response = await fetch('/api/chart/combined');
        console.log('Combined chart API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Combined chart data:', data);
        
        if (!predictionChart) {
            console.warn('Prediction chart not initialized');
            return;
        }
        
        if (!data.historical || !Array.isArray(data.historical)) {
            console.warn('Invalid historical data format');
            return;
        }
        
        if (!data.predictions || !Array.isArray(data.predictions)) {
            console.warn('Invalid predictions data format');
            return;
        }
        
        const historicalLabels = data.historical.map(d => new Date(d.date).toLocaleDateString());
        const historicalTemps = data.historical.map(d => d.temperature);
        
        const predictionLabels = data.predictions.map(d => new Date(d.date).toLocaleDateString());
        const predictionTemps = data.predictions.map(d => d.temperature);
        
        // Add evaluated predictions if available
        const evaluatedLabels = data.evaluated ? data.evaluated.map(d => new Date(d.date).toLocaleDateString()) : [];
        const evaluatedTemps = data.evaluated ? data.evaluated.map(d => d.actual_temperature) : [];
        
        // Combine labels
        const allLabels = [...historicalLabels, ...predictionLabels, ...evaluatedLabels];
        
        // Prepare datasets
        const historicalData = [...historicalTemps, ...new Array(predictionTemps.length + evaluatedTemps.length).fill(null)];
        const predictionData = [...new Array(historicalTemps.length).fill(null), ...predictionTemps, ...new Array(evaluatedTemps.length).fill(null)];
        const evaluatedData = [...new Array(historicalTemps.length + predictionTemps.length).fill(null), ...evaluatedTemps];
        
        predictionChart.data.labels = allLabels;
        predictionChart.data.datasets[0].data = historicalData;
        predictionChart.data.datasets[1].data = predictionData;
        predictionChart.data.datasets[2].data = evaluatedData;
        predictionChart.update();
        
        console.log('Combined chart updated successfully');
    } catch (error) {
        console.error('Failed to load combined chart data:', error);
    }
}

// Load historical data with debug
async function loadHistoricalData() {
    console.log('Loading historical data...');
    try {
        const response = await fetch('/api/temperature/historical?days=14');
        console.log('Historical data API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Historical data:', data);
        
        if (!temperatureChart) {
            console.warn('Temperature chart not initialized');
            return;
        }
        
        if (!Array.isArray(data)) {
            console.error('Expected array for historical data, got:', typeof data);
            return;
        }
        
        if (data.length > 0) {
            const recentData = data.slice(-20);
            const labels = recentData.map(d => {
                const date = new Date(d.date_time);
                return date.toLocaleDateString() + ' ' + date.getHours().toString().padStart(2, '0') + ':00';
            });
            const temperatures = recentData.map(d => d.temperature);
            
            temperatureChart.data.labels = labels;
            temperatureChart.data.datasets[0].data = temperatures;
            temperatureChart.update();
            
            console.log(`Historical chart updated with ${temperatures.length} data points`);
        } else {
            console.log('No historical data available');
        }
    } catch (error) {
        console.error('Failed to load historical data:', error);
    }
}

// Enhanced 14-day prediction with database saving and debug
async function predict14Days() {
    console.log('Starting 14-day prediction...');
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '🔄 Generating & saving 14-day forecast...';

    try {
        const response = await fetch('/api/predict/14-day', { method: 'POST' });
        console.log('14-day prediction API response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('14-day prediction data:', data);

        if (data.success) {
            // Fix the field names to match the actual backend response
            const batchDate = data.prediction_batch_date ? new Date(data.prediction_batch_date).toLocaleString() : 'Unknown';
            const dbType = data.database_type || (data.saved_to_database ? 'unknown database' : 'not saved');
            
            console.log('14-day response data:', data); // Debug log
            
            showMessage('prediction-result', 
                `✅ 14-day forecast created and saved to ${dbType}: ${data.predictions.length} predictions (${batchDate})`, 
                'success'
            );
            
            // Update prediction chart
            if (data.predictions && Array.isArray(data.predictions)) {
                updatePredictionChart(data.predictions);
            }
            
            // Show predictions in a formatted way with prediction IDs
            const predictionList = data.predictions.map(p => 
                `Day ${p.day} (${p.date}): ${p.predicted_temperature}°C (${p.confidence}%) - ID: #${p.prediction_id || 'pending'}`
            ).join('<br>');
            
            const resultsEl = document.getElementById('14-day-results');
            if (resultsEl) {
                resultsEl.innerHTML = `
                    <div class="prediction-summary">
                        <h4>14-Day Forecast Generated & Saved</h4>
                        <div class="batch-info">
                            <small><strong>Batch Date:</strong> ${batchDate}</small><br>
                            <small><strong>Database:</strong> ${dbType}</small><br>
                            <small><strong>Total Predictions:</strong> ${data.total_predictions || data.predictions.length}</small><br>
                            <small><strong>Saved to Database:</strong> ${data.saved_to_database ? 'Yes' : 'No'}</small>
                        </div>
                        <div class="prediction-details">
                            <small>${predictionList}</small>
                        </div>
                        <div class="evaluation-note">
                            <small><em>💡 These predictions will be automatically evaluated when their target dates are reached, or you can evaluate them manually.</em></small>
                        </div>
                    </div>
                `;
            }
            
            // Refresh other components
            loadRecentPredictions();
            loadPendingEvaluations();
            loadAnalytics();
            
        } else {
            showMessage('prediction-result', data.error || '14-day prediction failed', 'error');
        }
    } catch (error) {
        console.error('14-day prediction failed:', error);
        showMessage('prediction-result', `Connection error: ${error.message}`, 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// Add temperature data
async function addData() {
    const temp = parseFloat(document.getElementById('temp').value);
    const humidity = parseFloat(document.getElementById('humidity').value) || null;
    const pressure = parseFloat(document.getElementById('pressure').value) || null;
    const wind_speed = parseFloat(document.getElementById('wind_speed').value) || null;
    const cloud_cover = parseFloat(document.getElementById('cloud_cover').value) || null;

    if (isNaN(temp)) {
        showMessage('add-data-result', 'Please enter a valid temperature', 'error');
        return;
    }

    try {
        const response = await fetch('/api/temperature', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temperature: temp, humidity, pressure, wind_speed, cloud_cover })
        });

        const result = await response.json();

        if (result.success) {
            showMessage('add-data-result', 'Temperature data added successfully!', 'success');
            
            // Clear form
            ['temp', 'humidity', 'pressure', 'wind_speed', 'cloud_cover'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            
            // Refresh displays
            updateSystemStatus();
            loadAnalytics();
            loadHistoricalData();
        } else {
            showMessage('add-data-result', 'Failed to add data', 'error');
        }
    } catch (error) {
        showMessage('add-data-result', 'Connection error', 'error');
    }
}

// Single day prediction
async function predictNextDay() {
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '🔄 Predicting...';

    try {
        const response = await fetch('/api/predict/next-day', { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            const predTempEl = document.getElementById('prediction-temp');
            const confidenceEl = document.getElementById('confidence');
            const predDateEl = document.getElementById('pred-date');
            const predDisplayEl = document.getElementById('prediction-display');
            
            if (predTempEl) predTempEl.textContent = data.predicted_temperature + '°C';
            if (confidenceEl) confidenceEl.textContent = Math.round(data.confidence * 100) + '%';
            if (predDateEl) predDateEl.textContent = new Date(data.target_date).toLocaleDateString();
            if (predDisplayEl) predDisplayEl.style.display = 'block';
            
            showMessage('prediction-result', `Tomorrow: ${data.predicted_temperature}°C (${Math.round(data.confidence * 100)}% confidence)`, 'success');
            loadRecentPredictions();
            loadPendingEvaluations();
        } else {
            showMessage('prediction-result', data.error || 'Prediction failed', 'error');
        }
    } catch (error) {
        showMessage('prediction-result', 'Connection error', 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// Update prediction chart with new data
function updatePredictionChart(predictions) {
    if (!predictionChart || !Array.isArray(predictions)) return;
    
    try {
        const labels = predictions.map(p => p.date);
        const temps = predictions.map(p => p.predicted_temperature);
        
        // Add to existing chart
        const currentLabels = predictionChart.data.labels || [];
        const currentPredictions = predictionChart.data.datasets[1].data || [];
        
        predictionChart.data.labels = [...currentLabels, ...labels];
        predictionChart.data.datasets[1].data = [...currentPredictions, ...temps];
        predictionChart.update();
        
        console.log('Prediction chart updated with new data');
    } catch (error) {
        console.error('Failed to update prediction chart:', error);
    }
}

// Tab switching function
function showTab(tabName) {
    console.log('Switching to tab:', tabName);
    
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Remove active class from all tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Show selected tab content
    const tabContent = document.getElementById(tabName + '-content');
    if (tabContent) {
        tabContent.classList.add('active');
    } else {
        console.error(`Tab content ${tabName}-content not found`);
    }
    
    // Add active class to clicked tab
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    // Load data based on tab
    if (tabName === 'analytics') {
        loadAnalytics();
    } else if (tabName === 'predictions') {
        loadRecentPredictions();
    } else if (tabName === 'evaluations') {
        loadPendingEvaluations();
    } else if (tabName === 'chart') {
        loadHistoricalData();
    } else if (tabName === 'forecast') {
        loadCombinedChart();
    }
}

// Manual retraining
async function retrainModel() {
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '🔄 Training...';

    try {
        const response = await fetch('/api/retrain', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showMessage('prediction-result', 'Model retrained successfully!', 'success');
            updateSystemStatus();
        } else {
            showMessage('prediction-result', result.message || 'Training failed', 'error');
        }
    } catch (error) {
        showMessage('prediction-result', 'Connection error', 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// Save current weather to database
async function saveWeatherData() {
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '🔄 Saving...';

    try {
        const response = await fetch('/api/weather/save', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showMessage('add-data-result', 'Weather data saved successfully!', 'success');
            updateSystemStatus();
            loadAnalytics();
            loadHistoricalData();
        } else {
            showMessage('add-data-result', result.error || 'Failed to save weather data', 'error');
        }
    } catch (error) {
        showMessage('add-data-result', 'Connection error', 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// NEW: Quick add actual temperature for immediate evaluation
async function quickAddActualTemp() {
    const actualTemp = parseFloat(document.getElementById('quick-actual-temp').value);
    const predictionDateInput = document.getElementById('quick-prediction-date').value;
    
    if (isNaN(actualTemp)) {
        showMessage('evaluation-result', 'Please enter a valid actual temperature', 'error');
        return;
    }
    
    if (!predictionDateInput) {
        showMessage('evaluation-result', 'Please select a prediction date', 'error');
        return;
    }
    
    if (actualTemp < -50 || actualTemp > 60) {
        showMessage('evaluation-result', 'Temperature seems unrealistic (-50°C to 60°C expected)', 'error');
        return;
    }

    try {
        // Format the date properly for the API
        const targetDate = new Date(predictionDateInput);
        
        // Validate the date
        if (isNaN(targetDate.getTime())) {
            showMessage('evaluation-result', 'Invalid date selected', 'error');
            return;
        }
        
        // Format as ISO string for consistent server processing
        const formattedDate = targetDate.toISOString();
        
        console.log('Sending quick evaluation request:', {
            target_date: formattedDate,
            actual_temperature: actualTemp,
            evaluation_type: 'manual_quick'
        });

        const response = await fetch('/api/predictions/evaluate-by-date', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                target_date: formattedDate,
                actual_temperature: actualTemp,
                evaluation_type: 'manual_quick'
            })
        });

        console.log('Quick evaluation response status:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Server error response:', errorText);
            throw new Error(`Server error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log('Quick evaluation result:', result);

        if (result.success) {
            showMessage('evaluation-result', 
                `✅ ${result.evaluated_count} prediction(s) evaluated for ${targetDate.toLocaleDateString()}`, 
                'success'
            );
            
            // Clear form
            document.getElementById('quick-actual-temp').value = '';
            document.getElementById('quick-prediction-date').value = '';
            
            // Refresh displays
            loadRecentPredictions();
            loadPendingEvaluations();
            loadAnalytics();
        } else {
            showMessage('evaluation-result', result.error || 'Quick evaluation failed', 'error');
        }
    } catch (error) {
        console.error('Quick evaluation failed:', error);
        showMessage('evaluation-result', `Quick evaluation error: ${error.message}`, 'error');
    }
}

// NEW: Export evaluation data
async function exportEvaluationData() {
    console.log('Exporting evaluation data...');
    
    try {
        const response = await fetch('/api/predictions/export-evaluations');
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `temperature_predictions_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showMessage('evaluation-result', 'Evaluation data exported successfully!', 'success');
    } catch (error) {
        console.error('Export failed:', error);
        showMessage('evaluation-result', `Export error: ${error.message}`, 'error');
    }
}

// NEW: Import historical evaluations from CSV
async function importEvaluationData(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    console.log('Importing evaluation data from file:', file.name);
    
    const formData = new FormData();
    formData.append('evaluation_file', file);
    
    try {
        const response = await fetch('/api/predictions/import-evaluations', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage('evaluation-result', 
                `✅ Imported ${result.imported_count} evaluations (${result.skipped_count} skipped)`, 
                'success'
            );
            
            // Refresh displays
            loadRecentPredictions();
            loadPendingEvaluations();
            loadAnalytics();
            loadCombinedChart();
        } else {
            showMessage('evaluation-result', result.error || 'Import failed', 'error');
        }
    } catch (error) {
        console.error('Import failed:', error);
        showMessage('evaluation-result', `Import error: ${error.message}`, 'error');
    } finally {
        // Clear file input
        event.target.value = '';
    }
}

// Debug function to check API endpoints
async function debugAPIEndpoints() {
    console.log('=== API Debug Check ===');
    
    const endpoints = [
        '/api/health',
        '/api/analytics',
        '/api/predictions/recent',
        '/api/predictions/pending-evaluation',
        '/api/temperature/historical?days=7',
        '/api/chart/combined',
        '/api/weather/current'
    ];
    
    for (const endpoint of endpoints) {
        try {
            console.log(`Testing ${endpoint}...`);
            const response = await fetch(endpoint);
            console.log(`${endpoint}: ${response.status} ${response.statusText}`);
            
            if (response.ok) {
                const data = await response.json();
                console.log(`${endpoint} data:`, data);
            }
        } catch (error) {
            console.error(`${endpoint} failed:`, error);
        }
    }
    
    console.log('=== API Debug Complete ===');
}

// Call debug function (remove this in production)
setTimeout(debugAPIEndpoints, 2000);