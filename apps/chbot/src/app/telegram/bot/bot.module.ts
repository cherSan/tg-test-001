import {Module} from "@nestjs/common";
import {BotUpdate} from "./bot.update";
import {BotService} from "./bot.service";

@Module({
  providers: [BotUpdate, BotService],
})
export class BotModule {}
