from pymongo import MongoClient

MONGO_URI = "mongodb+srv://wrobel:Jerseyjersey2024@strato.global.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000"
client = MongoClient(MONGO_URI)
db = client["weatherDB"]
collection = db["weatherData"]

# Fetch 5 sample documents
samples = collection.find().limit(5)

for doc in samples:
    print(doc)