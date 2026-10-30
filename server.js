import 'dotenv/config';
import app from './app.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET (at least 32 characters) is required');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AgroMarket API: http://localhost:${PORT}`);
});
