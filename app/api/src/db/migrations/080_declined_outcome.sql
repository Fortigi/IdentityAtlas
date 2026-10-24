-- Migration 072: a question the assistant declines on purpose.
--
-- "Is Trump the president?" and "remove Jan from the Finance group" used to be
-- filed as `not-understood` — which reads, in an evaluation, as the model
-- failing. It did not fail; it refused, which is what it should do. Its own
-- outcome, so "how often does it refuse, and was it right to" can be counted.

ALTER TABLE "BotConversations" DROP CONSTRAINT IF EXISTS "ck_BotConversations_outcome";
ALTER TABLE "BotConversations" ADD CONSTRAINT "ck_BotConversations_outcome"
    CHECK ("outcome" IN (
        'answered', 'interpreted', 'clarified', 'confirm', 'declined',
        'unknown-caller', 'not-understood', 'timeout', 'failed'
    ));
