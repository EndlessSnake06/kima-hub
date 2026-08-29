#!/bin/bash
# Development environment setup script

echo "🚀 Setting up Kima development environment..."

# Check if .env exists
if [ ! -f backend/.env ]; then
    echo "📝 Creating backend/.env from .env.example..."
    cp .env.example backend/.env
    echo "⚠️  Please update backend/.env with your configuration"
fi

# Check PostgreSQL (v1-dedicated dev server; see docker-compose.dev.yml)
echo "🔍 Checking PostgreSQL (port 5455)..."
if ! nc -z localhost 5455 2>/dev/null; then
    echo "❌ PostgreSQL not running on port 5455"
    echo "   Start with: docker compose -f docker-compose.dev.yml up -d postgres"
    exit 1
fi

# Check Redis
echo "🔍 Checking Redis (port 6390)..."
if ! nc -z localhost 6390 2>/dev/null; then
    echo "❌ Redis not running on port 6390"
    echo "   Start with: docker compose -f docker-compose.dev.yml up -d redis"
    exit 1
fi

echo "✅ All services are running!"
echo "📦 Installing dependencies..."
cd backend && npm install && cd ..

echo "🎉 Setup complete! Start development with: cd backend && npm run dev"
