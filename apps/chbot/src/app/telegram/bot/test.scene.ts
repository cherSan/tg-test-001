import { Scene, SceneEnter, SceneLeave, Command } from 'nestjs-telegraf';
import {Context} from "telegraf";

export const RND_SCENE_ID = 'RND_SCENE_ID'
@Scene(RND_SCENE_ID)
export class RandomNumberScene {
  @SceneEnter()
  onSceneEnter(): string {
    console.log('Enter to scene');
    return 'Welcome on scene ✋';
  }

  @SceneLeave()
  onSceneLeave(): string {
    console.log('Leave from scene');
    return 'Bye Bye 👋';
  }

  @Command(['rng', 'random'])
  onRandomCommand(): number {
    console.log('Use "random" command');
    return Math.floor(Math.random() * 11);
  }

  @Command('leave')
  async onLeaveCommand(ctx: Context): Promise<void> {
    await (ctx as any).scene.leave();
  }
}
