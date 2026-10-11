const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');
