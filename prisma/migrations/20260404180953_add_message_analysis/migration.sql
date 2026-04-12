-- CreateTable
CREATE TABLE "MessageAnalysis" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageAnalysis_messageId_key" ON "MessageAnalysis"("messageId");

-- AddForeignKey
ALTER TABLE "MessageAnalysis" ADD CONSTRAINT "MessageAnalysis_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
