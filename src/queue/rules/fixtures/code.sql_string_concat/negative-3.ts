// Bad: db.query('SELECT * FROM users WHERE id = ' + userId);
db.query('SELECT * FROM users WHERE id = $1', [userId]);
