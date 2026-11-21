import { Global, Module } from '@nestjs/common';
import { AgentApiController } from './agent-api.controller';
import { AgentAuthGuard } from './agent-auth.guard';
import { AgentConfigService } from './agent-config.service';
import { AgentEventsService } from './agent-events.service';
import { AgentGatewayService } from './agent-gateway.service';
import { AgentRegistrationService } from './agent-registration.service';
import { CommandsService } from './commands.service';
import { ConnectionRegistry } from './connection-registry';
import { NodeAuthService } from './node-auth.service';

/**
 * Everything related to talking to agents: identity, registration, the
 * WebSocket gateway, the command queue and report ingestion.
 */
@Global()
@Module({
  controllers: [AgentApiController],
  providers: [NodeAuthService, AgentAuthGuard, ConnectionRegistry, CommandsService, AgentEventsService, AgentConfigService, AgentRegistrationService, AgentGatewayService],
  exports: [NodeAuthService, AgentAuthGuard, ConnectionRegistry, CommandsService, AgentEventsService, AgentConfigService, AgentGatewayService],
})
export class AgentsModule {}
