// AI Temperature Prediction System - Frontend JavaScript
let temperatureChart;
let currentPredictionId = null;

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    updateSystemStatus();
    loadAnalytics();
    loadRecentPredictions();
    initChart();
    getCurrentWeather(); // Load current weather on startup
    
    // Auto-refresh every 30 seconds
    setInterval(updateSystemStatus, 30000);
    
    // Auto-refresh weather every 10 minutes
    setInterval(getCurrentWeather, 10 * 60 * 1000);
});

// System status
async function updateSystemStatus() {
    try {
        const response = await fetch('/api/health');
        const data = await response.json();
        
        const statusEl = document.getElementById('status-text');
        const dbType = data.database === 'in-memory' ? 'Local Storage' : 'Azure SQL';
        const modelStatus = data.model_trained ? 'Trained & Ready' : 'Ready (Need Data)';
        
        statusEl.innerHTML = `
            ${data.status === 'healthy' ? '✅' : '❌'} ${dbType} | 
            🧠 ${modelStatus} | 
            📊 ${data.data_summary.total_records || 0} Records
        `;
    } catch (error) {
        document.getElementById('status-text').innerHTML = '❌ Connection Error';
    }
}

// Show message helper
function showMessage(elementId, message, type = 'success') {
    const el = document.getElementById(elementId);
    el.className = `result ${type}`;
    el.textContent = message;
    el.style.display = 'block';
    
    setTimeout(() => {
        el.style.display = 'none';
    }, 5000);
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
            document.getElementById('temp').value = '';
            document.getElementById('humidity').value = '';
            document.getElementById('pressure').value = '';
            document.getElementById('wind_speed').value = '';
            document.getElementById('cloud_cover').value = '';
            
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

// Predict next day temperature
async function predictNextDay() {
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '🔄 Predicting...';

    try {
        const response = await fetch('/api/predict/next-day', { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            currentPredictionId = data.prediction_id;
            
            // Update prediction display
            document.getElementById('prediction-temp').textContent = data.predicted_temperature + '°C';
            document.getElementById('confidence').textContent = Math.round(data.confidence * 100) + '%';
            document.getElementById('pred-id').textContent = '#' + data.prediction_id;
            document.getElementById('pred-date').textContent = new Date(data.target_date).toLocaleDateString();
            document.getElementById('prediction-display').style.display = 'block';
            
            // Auto-fill evaluation form
            document.getElementById('pred-id-eval').value = data.prediction_id;
            
            showMessage('prediction-result', `Prediction #${data.prediction_id}: ${data.predicted_temperature}°C`, 'success');
            
            // Refresh predictions list
            loadRecentPredictions();
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

// Evaluate prediction and help AI learn
async function evaluatePrediction() {
    const predId = parseInt(document.getElementById('pred-id-eval').value);
    const actualTemp = parseFloat(document.getElementById('actual-temp').value);

    if (isNaN(predId) || isNaN(actualTemp)) {
        showMessage('evaluation-result', 'Please enter valid prediction ID and temperature', 'error');
        return;
    }

    try {
        const response = await fetch('/api/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                prediction_id: predId, 
                actual_temperature: actualTemp 
            })
        });

        const result = await response.json();

        if (result.success) {
            const message = `Evaluation complete! Error: ${result.absolute_error}°C, Accuracy: ${result.accuracy_percentage}%` +
                (result.auto_retrain_triggered ? ' (Model automatically retrained)' : '');

            showMessage('evaluation-result', message, 'success');
            
            // Clear form
            document.getElementById('pred-id-eval').value = '';
            document.getElementById('actual-temp').value = '';
            
            // Refresh displays
            updateSystemStatus();
            loadAnalytics();
            loadRecentPredictions();
        } else {
            showMessage('evaluation-result', result.error || 'Evaluation failed', 'error');
        }
    } catch (error) {
        showMessage('evaluation-result', 'Connection error', 'error');
    }
}

// Manually retrain model
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

// Weather functions
async function getCurrentWeather() {
    try {
        const response = await fetch('/api/weather/current');
        const result = await response.json();
        
        const weatherDisplay = document.getElementById('weather-display');
        
        if (result.success) {
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
                        <div class="weather-item">
                            <span class="weather-label">Condition:</span>
                            <span class="weather-value">${data.weather_description}</span>
                        </div>
                    </div>
                    <div class="weather-timestamp">
                        Updated: ${new Date(data.timestamp).toLocaleTimeString()}
                    </div>
                </div>
            `;
            
            // Auto-populate the manual entry form with current weather
            document.getElementById('temp').value = data.temperature;
            document.getElementById('humidity').value = data.humidity;
            document.getElementById('pressure').value = data.pressure;
            document.getElementById('wind_speed').value = data.wind_speed;
            document.getElementById('cloud_cover').value = data.cloud_cover;
            
        } else {
            weatherDisplay.innerHTML = `
                <div class="weather-error">
                    <p>Weather API not available</p>
                    <small>${result.configured ? 'API configured but request failed' : 'API key not configured'}</small>
                    <p><small>Get your free API key from <a href="https://openweathermap.org/api" target="_blank">OpenWeatherMap</a></small></p>
                </div>
            `;
        }
    } catch (error) {
        document.getElementById('weather-display').innerHTML = `
            <div class="weather-error">
                <p>Failed to load weather data</p>
                <small>${error.message}</small>
            </div>
        `;
    }
}

async function saveCurrentWeather() {
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '💾 Saving...';

    try {
        const response = await fetch('/api/weather/save', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showMessage('weather-result', `Weather data saved: ${result.data.temperature}°C`, 'success');
            
            // Refresh displays
            updateSystemStatus();
            loadAnalytics();
            loadHistoricalData();
        } else {
            showMessage('weather-result', result.error || 'Failed to save weather data', 'error');
        }
    } catch (error) {
        showMessage('weather-result', 'Connection error', 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}
async function loadAnalytics() {
    try {
        const response = await fetch('/api/analytics');
        const data = await response.json();

        document.getElementById('total-data').textContent = data.total_data_points || 0;
        document.getElementById('total-predictions').textContent = data.total_predictions || 0;
        document.getElementById('avg-error').textContent = data.average_error ? data.average_error.toFixed(2) + '°C' : '0°C';
        document.getElementById('accuracy').textContent = data.recent_accuracy ? Math.round(data.recent_accuracy) + '%' : '0%';
    } catch (error) {
        console.error('Failed to load analytics:', error);
    }
}

// Load and display recent predictions
async function loadRecentPredictions() {
    try {
        const response = await fetch('/api/predictions/recent');
        const data = await response.json();

        const listEl = document.getElementById('predictions-list');
        
        if (data.length === 0) {
            listEl.innerHTML = '<div class="loading">No predictions yet. Make your first prediction!</div>';
            return;
        }

        listEl.innerHTML = data.map(pred => {
            const date = new Date(pred.prediction_date).toLocaleDateString();
            const targetDate = new Date(pred.target_date).toLocaleDateString();
            
            return `
                <div class="prediction-item ${pred.status}">
                    <div>
                        <strong>#${pred.id}</strong> Predicted: ${pred.predicted_temperature}°C for ${targetDate}
                        <br><small>Made: ${date} | Confidence: ${Math.round(pred.confidence * 100)}%</small>
                        ${pred.actual_temperature ? 
                            `<br><small>Actual: ${pred.actual_temperature}°C | Error: ${pred.absolute_error.toFixed(2)}°C</small>` : 
                            '<br><small>Awaiting actual temperature for learning</small>'
                        }
                    </div>
                    <span class="status-badge ${pred.status}">${pred.status.toUpperCase()}</span>
                </div>
            `;
        }).join('');
    } catch (error) {
        document.getElementById('predictions-list').innerHTML = '<div class="loading">Failed to load predictions</div>';
        console.error('Failed to load predictions:', error);
    }
}

// Load historical data and update chart
async function loadHistoricalData() {
    try {
        const response = await fetch('/api/temperature/historical?days=14');
        const data = await response.json();
        
        if (temperatureChart && data.length > 0) {
            // Take last 20 data points for chart
            const recentData = data.slice(-20);
            const labels = recentData.map(d => {
                const date = new Date(d.date_time);
                return date.toLocaleDateString() + ' ' + date.getHours().toString().padStart(2, '0') + ':00';
            });
            const temperatures = recentData.map(d => d.temperature);
            
            temperatureChart.data.labels = labels;
            temperatureChart.data.datasets[0].data = temperatures;
            temperatureChart.update();
        }
    } catch (error) {
        console.error('Failed to load historical data:', error);
    }
}

// Initialize temperature chart
function initChart() {
    const ctx = document.getElementById('temperature-chart').getContext('2d');
    temperatureChart = new Chart(ctx, {
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
                tension: 0.4,
                pointBackgroundColor: 'rgb(102, 126, 234)',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                pointRadius: 5,
                pointHoverRadius: 7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Recent Temperature History',
                    font: {
                        size: 16,
                        weight: 'bold'
                    }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    title: {
                        display: true,
                        text: 'Temperature (°C)',
                        font: {
                            weight: 'bold'
                        }
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Date & Time',
                        font: {
                            weight: 'bold'
                        }
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    },
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            },
            elements: {
                point: {
                    hoverRadius: 8
                }
            }
        }
    });
    
    // Load initial data
    loadHistoricalData();
}

// Tab switching functionality
function showTab(tabName) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Remove active class from all tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Show selected tab content
    document.getElementById(tabName + '-content').classList.add('active');
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // Load data for specific tabs
    if (tabName === 'analytics') {
        loadAnalytics();
    } else if (tabName === 'predictions') {
        loadRecentPredictions();
    } else if (tabName === 'chart') {
        loadHistoricalData();
    }
}

// Utility functions

// Format numbers for display
function formatNumber(num, decimals = 2) {
    if (num === null || num === undefined || isNaN(num)) return '0';
    return parseFloat(num).toFixed(decimals);
}

// Format date for display
function formatDate(dateString) {
    return new Date(dateString).toLocaleString();
}

// Validate temperature input
function isValidTemperature(temp) {
    return !isNaN(temp) && temp >= -100 && temp <= 100;
}

// Show loading state
function showLoading(elementId) {
    const el = document.getElementById(elementId);
    if (el) {
        el.innerHTML = '<div class="loading">Loading...</div>';
    }
}

// Auto-save prediction ID when making predictions
function savePredictionId(id) {
    currentPredictionId = id;
    localStorage.setItem('lastPredictionId', id.toString());
}

// Load last prediction ID
function loadLastPredictionId() {
    const savedId = localStorage.getItem('lastPredictionId');
    if (savedId) {
        document.getElementById('pred-id-eval').value = savedId;
    }
}

// Initialize prediction ID loading on page load
document.addEventListener('DOMContentLoaded', function() {
    loadLastPredictionId();
});

// Export functions for testing (if needed)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        updateSystemStatus,
        addData,
        predictNextDay,
        evaluatePrediction,
        retrainModel,
        loadAnalytics,
        loadRecentPredictions,
        loadHistoricalData,
        showTab,
        formatNumber,
        isValidTemperature
    };
}