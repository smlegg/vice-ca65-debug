import * as vscode from 'vscode';
import { ContinuedEvent, InitializedEvent, LoggingDebugSession, StoppedEvent, TerminatedEvent, ThreadEvent, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugInfo } from './DebugInfo.js';
import { ViceMonitor } from './ViceMonitor.js';
import { report } from 'process';

interface ViceCa65LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments
{
	program: string;
	debugInfo: string
}

class ViceCa65DebugSession extends LoggingDebugSession
{
	debugInfo: DebugInfo | null = null;
	vice: ViceMonitor | null = null;
	breakpointsBySource: {[ source: string]: number[]} = {};

	public constructor()
	{
		super();
	}

	protected override initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void
	{
		if (response.body)
		{
			response.body.supportsTerminateRequest = true;
		}
		this.sendResponse(response);
	}

	protected override launchRequest(response: DebugProtocol.LaunchResponse, args: ViceCa65LaunchRequestArguments, request?: DebugProtocol.Request): void
	{
		if (args.debugInfo)
		{
			this.debugInfo = new DebugInfo(args.debugInfo);
		}

		this.vice = new ViceMonitor();
		this.vice.onBreakpoint(() =>
		{
			this.sendEvent(new StoppedEvent("breakpoint", 1));
		});
		this.vice.start(args.program, () => {
			this.sendEvent(new InitializedEvent());
			this.sendEvent(new ThreadEvent("started", 1));
		});
		this.sendResponse(response);
	}

	protected override terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void
	{
		this.vice?.stop(() => {
			this.sendEvent(new TerminatedEvent());
			this.vice = null;
		});
		this.sendResponse(response);
	}

	protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void
	{
		this.vice?.pause(() =>
		{
			this.sendEvent(new StoppedEvent("paused", 1));
		});
		this.sendResponse(response);
	}

	protected override continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void
	{
		this.vice?.resume(() =>
		{
			this.sendEvent(new ContinuedEvent(1));
		});
		this.sendResponse(response);
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void
	{
		response.body = { threads: [{ id: 1, name: "Main" }]};
		this.sendResponse(response);
	}

	protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void
	{
		const sourceLocation = this.debugInfo?.sourceLocation(this.vice?.PC() ?? 0);
		const name = sourceLocation ? `${sourceLocation.fileName}, line ${sourceLocation.line}` : (this.vice?.PC().toString(16) ?? "(unknown)");
		const source: DebugProtocol.Source | undefined = sourceLocation ? {
			name: sourceLocation.fileName,
			path: this.convertDebuggerPathToClient(sourceLocation.fileName)
		} : undefined;

		response.body = {
			stackFrames: [
				{
					id: 1,
					name: name,
					source: source,
					line: sourceLocation?.line ?? 0,
					column: 0
				}
			],
			totalFrames: 1
		};
		this.sendResponse(response);
	}

	protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void
	{
		response.body = {
			scopes: [
				{
					name: "Registers",
					presentationHint: "registers",
					variablesReference: 1,
					expensive: false
				}
			]
		};
		this.sendResponse(response);
	}

	protected override variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void
	{
		if (args.variablesReference === 1)
		{
			const registers = this.vice?.Registers();
			if (registers)
			{
				var variables: Variable[] = [];
				for (const r of registers)
				{
					variables.push({
						name: r.name,
						value: r.toString(),
						variablesReference: 0
					});
				}
				response.body = { variables: variables };
			}
		}
		this.sendResponse(response);
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void
	{
		this.vice?.step(true, () => {
			this.sendEvent(new StoppedEvent("step", 1));
		});
		this.sendResponse(response);
	}

	protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void
	{
		this.vice?.step(false, () => {
			this.sendEvent(new StoppedEvent("step", 1));
		});
		this.sendResponse(response);
	}

	protected override stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void
	{
		this.vice?.untilReturn(() => {
			this.sendEvent(new StoppedEvent("step", 1));
		});
		this.sendResponse(response);
	}

	protected override setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): void
	{
		if (args.breakpoints && args.source.path)
		{
			const source = args.source.path;
			if (source in this.breakpointsBySource)
			{
				for (const breakpointID of this.breakpointsBySource[source])
				{
					this.vice?.removeBreakpoint(breakpointID);
				}
			}

			this.breakpointsBySource[source] = [];

			for (const breakpoint of args.breakpoints)
			{
				const address = this.debugInfo?.address({ fileName: source, line: breakpoint.line });
				if (address)
				{
					this.vice?.setBreakpoint(address, (breakpointID: number) => { this.breakpointsBySource[source].push(breakpointID); });
				}
			}
		}
	}
}

class ViceCa65DebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory
{
	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor>
	{
		return new vscode.DebugAdapterInlineImplementation(new ViceCa65DebugSession());
	}
}

export function activate(context: vscode.ExtensionContext)
{
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('vice-ca65', new ViceCa65DebugAdapterFactory()));
}

export function deactivate() {}
