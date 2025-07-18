from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from dotenv import load_dotenv
import os
from datetime import datetime, timedelta
import numpy as np
from sklearn.linear_model import LinearRegression
import joblib

load_dotenv()

app = Flask(__name__)
CORS(app)

# MongoDB connection URI from .env file or hardcoded here (replace accordingly)
MONGO_URI = os.getenv("MONGO_URI") or "mongodb+srv://wrobel:Jerseyjersey2024@strato.global.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000"

client = MongoClient(MONGO_URI)
db = client["weatherDB"]
collection = db["weatherData"]
MODEL_FILE = "model.joblib"

@app.route('/data', methods=['GET'])
def get_all_data():
    records = collection.find({}, {"_id": 0})
    return jsonify(list(records))

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


def load_training_data():
    data_cursor = collection.find({"actual": {"$exists": True}}, {"_id": 0, "date": 1, "actual": 1})
    data = list(data_cursor)

    X = []
    y = []

    for item in data:
        try:
            dt = datetime.strptime(item["date"], "%Y-%m-%d")
            X.append([dt.toordinal()])
            y.append(item["actual"])
        except Exception as e:
            print(f"Skipping invalid date format: {item['date']} - {e}")

    return np.array(X), np.array(y)


@app.route('/train', methods=['POST'])
def train():
    X, y = load_training_data()

    if len(X) == 0:
        return jsonify({"error": "No training data found"}), 400

    model = LinearRegression()
    model.fit(X, y)
    joblib.dump(model, MODEL_FILE)

    return jsonify({"message": "Model trained successfully"})


@app.route('/predict', methods=['GET'])
def predict():
    try:
        model = joblib.load(MODEL_FILE)
    except Exception:
        return jsonify({"error": "Model not trained yet"}), 400

    # Get last date from training data to start predictions from next day
    last_record = collection.find_one(sort=[("date", -1)])
    if last_record:
        last_date = datetime.strptime(last_record["date"], "%Y-%m-%d")
    else:
        # fallback to today if no data
        last_date = datetime.today()

    # Predict next 30 days starting from day after last known date
    future_dates = [last_date + timedelta(days=i) for i in range(1, 31)]
    X_future = np.array([[d.toordinal()] for d in future_dates])
    preds = model.predict(X_future)

    response = []
    for date, pred in zip(future_dates, preds):
        response.append({
            "date": date.strftime("%Y-%m-%d"),
            "predicted": float(pred)
        })

    return jsonify(response)


if __name__ == '__main__':
    app.run(debug=True, port=5002)
