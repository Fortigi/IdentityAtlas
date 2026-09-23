-- Migration 073: the model's first reply, when a correction round replaced it.
--
-- rawReply holds the reply that produced the answer. When that was the second
-- attempt, what the first one said is the half of the story an evaluation
-- needs: "the correction dropped the 90-day window" can only be seen with both.

ALTER TABLE "BotConversations" ADD COLUMN IF NOT EXISTS "firstReply" TEXT;
COMMENT ON COLUMN "BotConversations"."firstReply" IS
  'The model''s first reply verbatim, only when a correction round replaced it (rawReply is then the correction). NULL otherwise.';
