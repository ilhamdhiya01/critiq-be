export async function logout(token: string) {
  try {
    await cache.delete(token);
  } catch {
    // already gone: logging out twice is fine
  }
}
