from flask import Flask, jsonify, request
from pymongo import MongoClient
from flask_cors import CORS
from datetime import datetime, timedelta
from sklearn.linear_model import LinearRegression
import numpy as np
import os
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

app = Flask(__name__)
CORS(app)

# MongoDB connection
MONGO_URI = "mongodb+srv://wrobel:Jerseyjersey2024@strato.global.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000"
client = MongoClient(MONGO_URI)
db = client["weatherDB"]
collection = db["weatherData"]

# ML model
model = LinearRegression()

@app.route('/data', methods=['GET'])
def get_data():
    # Fetch all documents, exclude the MongoDB _id field from the output
    data = list(collection.find({}, {"_id": 0}))
    return jsonify(data)

@app.route('/add', methods=['POST'])
def add_data():
    entry = request.json
    if "date" not in entry or "actual" not in entry:
        return jsonify({"error": "Missing date or actual field"}), 400

    collection.insert_one({
        "date": entry["date"],
        "actual": entry["actual"]
    })
    return jsonify({"message": "Data added successfully"})

@app.route('/train', methods=['POST'])
def train():
    # Get training data
    data = list(collection.find({"actual": {"$exists": True}}, {"_id": 0, "date": 1, "actual": 1}))
    
    if len(data) < 2:
        return jsonify({"error": "Not enough data to train"}), 400

    # Sort and convert dates to numeric (days since first date)
    data.sort(key=lambda x: x['date'])
    dates = [datetime.strptime(d["date"], "%Y-%m-%d") for d in data]
    temps = [d["actual"] for d in data]
    
    base_date = dates[0]
    x = np.array([(d - base_date).days for d in dates]).reshape(-1, 1)
    y = np.array(temps)

    model.fit(x, y)
    
    return jsonify({"message": "Training completed", "samples": len(x)})

@app.route('/predict', methods=['GET'])
def predict():
    if not hasattr(model, 'coef_'):
        return jsonify({"error": "Model not trained yet"}), 400

    # Get training base date
    data = list(collection.find({"actual": {"$exists": True}}, {"_id": 0, "date": 1}))
    if not data:
        return jsonify([])

    data.sort(key=lambda x: x['date'])
    base_date = datetime.strptime(data[0]["date"], "%Y-%m-%d")

    # Generate predictions for next 30 days
    predictions = []
    for i in range(1, 31):
        future_date = base_date + timedelta(days=len(data) + i - 1)
        x_pred = np.array([(future_date - base_date).days]).reshape(1, -1)
        y_pred = model.predict(x_pred)[0]
        predictions.append({
            "date": future_date.strftime("%Y-%m-%d"),
            "predicted": y_pred
        })

    return jsonify(predictions)

if __name__ == '__main__':
    app.run(port=5001, debug=True)
