ALTER TABLE "send" ADD COLUMN "callback_token" TEXT;
ALTER TABLE "receive" ADD COLUMN "callback_token" TEXT;

CREATE UNIQUE INDEX "send_callback_token_key" ON "send"("callback_token");
CREATE UNIQUE INDEX "receive_callback_token_key" ON "receive"("callback_token");
