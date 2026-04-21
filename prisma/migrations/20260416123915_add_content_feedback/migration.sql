-- CreateTable
CREATE TABLE "public"."ContentFeedback" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "goal" TEXT,
    "valueType" TEXT,
    "category" TEXT,
    "customerType" TEXT,
    "serviceLevel" TEXT,
    "tone" TEXT,
    "hook" TEXT,
    "idea" TEXT,
    "script" TEXT,

    CONSTRAINT "ContentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentFeedback_goal_valueType_idx" ON "public"."ContentFeedback"("goal", "valueType");
