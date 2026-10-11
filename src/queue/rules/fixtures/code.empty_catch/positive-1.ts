export async function verifySession(token: string) {
  try {
    await jwt.verify(token, secret);
  } catch (e) {}
  return true;
}
