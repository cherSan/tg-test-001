import {Module} from "@nestjs/common";
import {BotUpdate} from "./bot.update";
import {BotService} from "./bot.service";
import {TestWizard} from "./test.wizzard";
import {RandomNumberScene} from "./test.scene";

@Module({
  providers: [BotUpdate, BotService, TestWizard, RandomNumberScene],
})
export class BotModule {}
