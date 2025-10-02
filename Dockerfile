# Use official Node.js 18 LTS 64-bit slim image
FROM node:18-bullseye-slim

# Set working directory inside container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first
COPY package*.json ./

# Install dependencies (including @tensorflow/tfjs-node)
RUN npm install --production

# Copy the rest of the app code
COPY . .

# Expose the port your app uses
ENV PORT=3000
EXPOSE 80

# Command to run the app
CMD ["node", "server.js"]
