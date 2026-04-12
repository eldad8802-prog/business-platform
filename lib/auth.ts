import { prisma } from "./prisma";

export async function getCurrentUser(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.split(" ")[1];

    const userId = Number(token);
    if (isNaN(userId)) return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    return user;
  } catch (error) {
    console.error("getCurrentUser error:", error);
    return null;
  }
}