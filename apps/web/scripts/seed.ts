// Seed demo para V0: 2 cuentas con alias + saldo. Gratis y local.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  await prisma.account.upsert({ where: { userId: "demo-irma" }, update: {}, create: { userId: "demo-irma", alias: "irma.mp", balance: "50000.00", currency: "ARS" } });
  await prisma.account.upsert({ where: { userId: "demo-juan" }, update: {}, create: { userId: "demo-juan", alias: "juan.mp", balance: "20000.00", currency: "ARS" } });
  const all = await prisma.account.findMany();
  console.log("Seed OK. Usa estos IDs en V0:");
  console.table(all.map((a) => ({ alias: a.alias, id: a.id, balance: a.balance })));
}
main().finally(() => prisma.$disconnect());
