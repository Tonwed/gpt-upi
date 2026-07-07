import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Demo seed data has been intentionally removed.
  // Production workers should be registered from the admin page or with the Telegram Bot /reg command.
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
