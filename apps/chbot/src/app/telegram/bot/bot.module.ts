import {Module} from "@nestjs/common";
import {BotUpdate} from "./bot.update";
import {BotService} from "./bot.service";
import {TestWizard} from "./test.wizzard";
import {RandomNumberScene} from "./test.scene";
import {DBModule} from "../../db/db.module";
import {AmneziaModule} from "../../amnezia/amnezia.module";

@Module({
  imports: [DBModule, AmneziaModule],
  providers: [BotUpdate, BotService, TestWizard, RandomNumberScene],
})
export class BotModule {}
