import {Module} from "@nestjs/common";
import {BotUpdate} from "./bot.update";
import {BotService} from "./bot.service";
import {TestWizard} from "./test.wizzard";
import {RandomNumberScene} from "./test.scene";
import {DBModule} from "../../db/db.module";
import {HideFoxModule} from "../../hidefox/hidefox.module";
import { CommandsService } from '../commands.service';

@Module({
  imports: [DBModule, HideFoxModule],
  providers: [BotUpdate, BotService, TestWizard, RandomNumberScene, CommandsService],
})
export class BotModule {}
