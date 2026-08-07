import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { AuxiliarySessionController } from './AuxiliarySessionController';

export interface PeriodicJobExecutionRequest {
  model: string;
  permissionMode: string;
  prompt: string;
}

export class PeriodicJobExecutionService {
  private readonly controller: AuxiliarySessionController;

  constructor(context: AuxiliaryExecutionContext) {
    this.controller = new AuxiliarySessionController(
      context,
      'periodic-job',
      { kind: 'provider-default' },
    );
  }

  async execute(request: PeriodicJobExecutionRequest): Promise<string> {
    try {
      await this.controller.startRoot();
      return await this.controller.execute({
        configuration: {
          model: request.model,
          permissionMode: request.permissionMode,
        },
        prompt: request.prompt,
        systemInstructions: { kind: 'provider-default' },
      });
    } finally {
      await this.controller.dispose();
    }
  }

  cancel(): void {
    this.controller.cancel();
  }

  async dispose(): Promise<void> {
    await this.controller.dispose();
  }
}
