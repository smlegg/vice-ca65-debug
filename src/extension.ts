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

interface VariableRef
{
	data: number[];
	address: number;
};

class ViceCa65DebugSession extends LoggingDebugSession
{
	debugInfo: DebugInfo | null = null;
	vice: ViceMonitor | null = null;
	breakpointsBySource: {[ source: string]: number[]} = {};
	variableRefs: VariableRef[] = [];
	variableRefsByName: {[ source: string]: number} = {};
	nextVariableRef: number = 2;

	public constructor()
	{
		super();
	}

	protected override initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void
	{
		if (response.body)
		{
			response.body.supportsTerminateRequest = true;
			response.body.supportsRestartRequest = true;
			response.body.supportsSetVariable = true;
			response.body.supportsSetExpression = true;
			response.body.supportsConditionalBreakpoints = true;
			response.body.supportsEvaluateForHovers = true;
		}
		this.sendResponse(response);
	}

	protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: ViceCa65LaunchRequestArguments, request?: DebugProtocol.Request): Promise<void>
	{
		if (args.debugInfo)
		{
			this.debugInfo = new DebugInfo(args.debugInfo);
		}

		this.vice = new ViceMonitor();
		this.vice.on('breakpoint', () =>
		{
			this.sendEvent(new StoppedEvent("breakpoint", 1));
		});
		this.vice.on('resumed', () =>
		{
			this.variableRefs = [];
			this.variableRefsByName = {};
			this.nextVariableRef = 2;
		});

		await this.vice.start(args.program);

		this.sendEvent(new InitializedEvent());
		this.sendEvent(new ThreadEvent("started", 1));
		this.sendResponse(response);
	}

	protected override async restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): Promise<void>
	{
		if (args.arguments)
		{
			const viceArgs = args.arguments as ViceCa65LaunchRequestArguments;
			this.vice?.restart(viceArgs.program);
			this.sendEvent(new ContinuedEvent(1));
			this.sendResponse(response);
		}
	}

	protected override async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): Promise<void>
	{
		await this.vice?.stop();
		this.sendEvent(new TerminatedEvent());
		this.vice = null;
		this.sendResponse(response);
	}

	protected override async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): Promise<void>
	{
		await this.vice?.pause();
		this.sendEvent(new StoppedEvent("paused", 1));
		this.sendResponse(response);
	}

	protected override async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): Promise<void>
	{
		await this.vice?.resume();
		this.sendEvent(new ContinuedEvent(1));
		this.sendResponse(response);
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void
	{
		response.body = { threads: [{ id: 1, name: "Main" }]};
		this.sendResponse(response);
	}

	protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void
	{
		const sourceLocation = this.debugInfo?.sourceLocation(this.vice?.pc() ?? 0);
		const name = sourceLocation ? `${sourceLocation.fileName}, line ${sourceLocation.line}` : (this.vice?.pc().toString(16) ?? "(unknown)");
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
			const registers = this.vice?.registers();
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
		} else {
			const data = this.variableRefs[args.variablesReference].data;
			const start = args.start ?? 0;
			const count = args.count ?? data.length;

			var variables: Variable[] = [];
			for (let i = 0; i < count; i++)
			{
				variables.push({
					name: `${i}`,
					value: `$${data[start + i].toString(16).padStart(2, '0')} (${data[start + i].toString()})`,
					variablesReference: 0
				});
			}
			response.body = { variables: variables };
		}
		this.sendResponse(response);
	}

	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): Promise<void>
	{
		const newValue = args.value.startsWith('$') ? parseInt(args.value.substring(1), 16) : parseInt(args.value);
		if (args.variablesReference === 1)
		{
			await this.vice?.setRegister(args.name, newValue);

			const newRegisters = this.vice?.registers();
			if (newRegisters)
			{
				const registerIndex = newRegisters?.findIndex((x) => x.name === args.name);

				response.body = {
					value: newRegisters[registerIndex].toString(),
				};

				this.sendResponse(response);
			}
		} else {
			const index = parseInt(args.name);
			const address = this.variableRefs[args.variablesReference].address;
			let data = this.variableRefs[args.variablesReference].data;
			data[index] = newValue;
			await this.vice?.writeMemory(address, data);
			data = await this.vice?.readMemory(address, data.length) ?? [];
			this.variableRefs[args.variablesReference].data = data;

			response.body = {
				value: `$${data[index].toString(16).padStart(2, '0')} (${data[index].toString()})`
			};

			this.sendResponse(response);
		}
	}

	protected override async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): Promise<void>
	{
		this.vice?.step(true);
		this.sendEvent(new StoppedEvent("step", 1));
		this.sendResponse(response);
	}

	protected override async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): Promise<void>
	{
		this.vice?.step(false);
		this.sendEvent(new StoppedEvent("step", 1));
		this.sendResponse(response);
	}

	protected override async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): Promise<void>
	{
		this.vice?.untilReturn();
		this.sendEvent(new StoppedEvent("step", 1));
		this.sendResponse(response);
	}

	protected override async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): Promise<void>
	{
		if (args.breakpoints && args.source.path)
		{
			const wasRunning = this.vice?.isRunning();

			const source = args.source.path;
			if (source in this.breakpointsBySource)
			{
				for (const breakpointID of this.breakpointsBySource[source])
				{
					this.vice?.removeBreakpoint(breakpointID);
				}
			}

			this.breakpointsBySource[source] = [];

			response.body = { breakpoints: [] };

			for (const breakpoint of args.breakpoints)
			{
				var responseBreakpoint: DebugProtocol.Breakpoint =
				{
					verified: false,
					source: args.source,
					line: breakpoint.line
				};

				const address = this.debugInfo?.address({ fileName: source, line: breakpoint.line });
				if (address)
				{
					const breakpointID = await this.vice?.setBreakpoint(address, breakpoint.condition);
					if (breakpointID !== undefined)
					{
						this.breakpointsBySource[source].push(breakpointID);

						responseBreakpoint.id = breakpointID;
						responseBreakpoint.verified = true;
					} else
					{
						responseBreakpoint.reason = 'failed';
					}
				} else
				{
					responseBreakpoint.reason = 'failed';
				}

				response.body.breakpoints.push(responseBreakpoint);
			}

			if (wasRunning)
			{
				await this.vice?.resume();
			}
		}

		this.sendResponse(response);
	}

	protected override async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void>
	{
		const value = this.debugInfo?.symbol(args.expression);
		if (value)
		{
			if (value.type === 'address')
			{
				const data = await this.vice?.readMemory(value.value, value.size ?? 1);
				if (data)
				{
					if (data.length <= 2)
					{
						var n;
						if (data.length === 1)
						{
							n = data[0];
						} else
						{
							n = data[0] | (data[1] << 8);
						}
						response.body = {
							result: `$${value.value.toString(16).padStart(4, '0')}: $${n.toString(16).padStart(data.length * 2, '0')} (${n.toString()})`,
							variablesReference: 0
						};
					} else
					{
						var variableRef = 0;
						if (args.expression in this.variableRefsByName)
						{
							variableRef = this.variableRefsByName[args.expression];
						} else
						{
							variableRef = this.nextVariableRef++;
						}

						this.variableRefs[variableRef] = { data: data, address: value.value };

						response.body = {
							result: `$${value.value.toString(16).padStart(4, '0')}:`,
							variablesReference: variableRef,
							indexedVariables: data.length
						};
					}
				} else
				{
					response.body = {
						result: value?.value.toString() ?? "<undefined>",
						variablesReference: 0
					};
				}
			} else
			{
				response.body = {
					result: value?.value.toString() ?? "<undefined>",
					variablesReference: 0
				};
			}
		}

		this.sendResponse(response);
	}

	protected override async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): Promise<void>
	{
		const value = this.debugInfo?.symbol(args.expression);
		if (value && value.type === 'address')
		{
			const size = value.size ?? 1;
			if (size <= 2)
			{
				const newValue = args.value.startsWith('$') ? parseInt(args.value.substring(1), 16) : parseInt(args.value);
				const data: number[] = (size === 1) ? [ newValue & 0xff ] : [ newValue & 0xff, newValue >> 8];
				await this.vice?.writeMemory(value.value, data);
			}
		}
		this.sendResponse(response);
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
