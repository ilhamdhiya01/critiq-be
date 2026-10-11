export async function verifySession(token: string) {
  try {
    await jwt.verify(token, secret);
  } catch (error) {
    throw new UnauthorizedException('Invalid session');
  }
}
