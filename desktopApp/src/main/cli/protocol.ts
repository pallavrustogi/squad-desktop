import { SquadProcess } from './copilot-process';

let commandCounter = 0;

export function generateId(): string {
  const timestamp = Date.now();
  const counter = ++commandCounter;
  return `cmd-${timestamp}-${counter}`;
}

export class Protocol {
  constructor(private squadProcess: SquadProcess) {}

  generateCommandId(): string {
    return generateId();
  }

  sendCommand(text: string, targetAgentId?: string): void {
    let message: string;
    if (targetAgentId) {
      message = `@${targetAgentId} ${text}`;
    } else {
      message = text;
    }
    this.squadProcess.send(message);
  }

  addAgent(name: string, role: string, emoji: string): void {
    const message = `agent:add ${name} ${role} ${emoji}`;
    this.squadProcess.send(message);
  }

  removeAgent(agentId: string): void {
    const message = `agent:remove ${agentId}`;
    this.squadProcess.send(message);
  }

  cancelCommand(commandId: string): void {
    const message = `queue:cancel ${commandId}`;
    this.squadProcess.send(message);
  }
}
