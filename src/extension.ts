import * as vscode from 'vscode';
import { ContinuedEvent, InitializedEvent, LoggingDebugSession, StoppedEvent, TerminatedEvent, ThreadEvent, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugInfo, DebugValue } from './DebugInfo.js';
import { ViceMonitor } from './ViceMonitor.js';
import { ViceValue  } from './ViceValue.js';

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

interface Expression
{
	value: number;
	size: number;
	literal: boolean;
	array: boolean;
}

class ViceCa65DebugSession extends LoggingDebugSession
{
	debugInfo: DebugInfo | null = null;
	vice: ViceMonitor | null = null;
	breakpointsBySource: {[ source: string]: number[]} = {};
	dataBreakpoints: number[] = [];
	variableRefs: VariableRef[] = [];
	variableRefsByName: {[ source: string]: number} = {};
	nextVariableRef: number = 2;
	dataRefs: Expression[] = [];
	temporaryDataRefs: Expression[] = [];

	async parseExpression(expr: string): Promise<Expression>
	{
		const deref = expr.startsWith('*');
		if (deref)
		{
			expr = expr.substring(1);
		}
		const parts = expr.split(',');
		const exprSize = (parts.length === 2) ? parseInt(parts[1]) : undefined;
		const symbolValue = this.debugInfo?.symbol(parts[0]);

		let value = symbolValue?.value ?? 0;
		if (symbolValue?.type === 'address' && deref)
		{
			const addressData = await this.vice?.readMemory(value, 2);
			if (addressData)
			{
				value = addressData[0] | (addressData[1] << 8);
			}
		}

		return {
			value: value,
			size: exprSize ? exprSize : (deref ? 1 : (symbolValue?.size ?? 1)),
			literal: symbolValue?.type === 'literal',
			array: exprSize !== undefined
		};
	}

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
			response.body.supportsDataBreakpoints = true;
			response.body.supportsDataBreakpointBytes = true;
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
			this.temporaryDataRefs = [];
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
				let variables: Variable[] = [];
				for (const r of registers)
				{
					variables.push({
						name: r.name,
						value: r.value.toString(),
						variablesReference: 0
					});
				}
				response.body = { variables: variables };
			}
		} else {
			const data = this.variableRefs[args.variablesReference].data;
			const start = args.start ?? 0;
			const count = args.count ?? data.length;

			let variables: Variable[] = [];
			for (let i = 0; i < count; i++)
			{
				variables.push({
					name: `${i}`,
					value: new ViceValue(data[start + i], 8).toString(),
					variablesReference: 0
				});
			}
			response.body = { variables: variables };
		}
		this.sendResponse(response);
	}

	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): Promise<void>
	{
		const newValue = ViceValue.fromString(args.value);
		if (args.variablesReference === 1)
		{
			await this.vice?.setRegister(args.name, newValue.value);

			const newRegisters = this.vice?.registers();
			if (newRegisters)
			{
				const registerIndex = newRegisters?.findIndex((x) => x.name === args.name);

				response.body = {
					value: newRegisters[registerIndex].value.toString(),
				};

				this.sendResponse(response);
			}
		} else {
			const index = parseInt(args.name);
			const address = this.variableRefs[args.variablesReference].address;
			let data = this.variableRefs[args.variablesReference].data;
			data[index] = newValue.value;
			await this.vice?.writeMemory(address, data);
			data = await this.vice?.readMemory(address, data.length) ?? [];
			this.variableRefs[args.variablesReference].data = data;

			response.body = {
				value: new ViceValue(data[index], 8).toString()
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
				let responseBreakpoint: DebugProtocol.Breakpoint =
				{
					verified: false,
					source: args.source,
					line: breakpoint.line
				};

				const address = this.debugInfo?.address({ fileName: source, line: breakpoint.line });
				if (address)
				{
					const breakpointID = await this.vice?.setBreakpoint(address, 1, 'exec', breakpoint.condition);
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

	protected override async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): Promise<void>
	{
		if (args.breakpoints)
		{
			const wasRunning = this.vice?.isRunning();

			for (const breakpointID of this.dataBreakpoints)
			{
				this.vice?.removeBreakpoint(breakpointID);
			}

			this.dataBreakpoints = [];

			for (const breakpoint of args.breakpoints)
			{
				let responseBreakpoint: DebugProtocol.Breakpoint =
				{
					verified: false,
				};

				let dataRef: Expression | undefined = undefined;
				if (breakpoint.dataId.startsWith('t'))
				{
					dataRef = this.temporaryDataRefs[parseInt(breakpoint.dataId.substring(1))];
				} else if (breakpoint.dataId.startsWith('p'))
				{
					dataRef = this.dataRefs[parseInt(breakpoint.dataId.substring(1))];
				} else if (breakpoint.dataId.startsWith('a'))
				{
					dataRef = {
						value: parseInt(breakpoint.dataId.substring(1)),
						size: 1,
						literal: false,
						array: false
					};
				}

				if (dataRef)
				{
					const breakpointID = await this.vice?.setBreakpoint(dataRef.value, dataRef.size, breakpoint.accessType ?? 'read', breakpoint.condition);
					if (breakpointID !== undefined)
					{
						this.dataBreakpoints.push(breakpointID);

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
			}

			if (wasRunning)
			{
				await this.vice?.resume();
			}

		}

		this.sendResponse(response);
	}

	protected override async dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments, request?: DebugProtocol.Request): Promise<void>
	{
		if (args.variablesReference !== 1)
		{
			if (args.asAddress)
			{
				const address = parseInt(args.name);
				if (address >=0 && address <= 0xffff)
				{
					response.body = {
						dataId: `a${address.toString()}`,
						description: args.name,
						accessTypes: [ 'read', 'write' ]
					};
				}
			} else
			{
				const expr = await this.parseExpression(args.name);

				let dataId;
				if (args.frameId)
				{
					dataId = `t${this.temporaryDataRefs.length}`;
					this.temporaryDataRefs.push(expr);
				} else
				{
					dataId = `p${this.dataRefs.length}`;
					this.dataRefs.push(expr);
				}

				response.body = {
					dataId: dataId,
					description: args.name,
					accessTypes: [ 'read', 'write' ]
				};
			}

			this.sendResponse(response);
		}
	}

	protected override async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void>
	{
		const expr = await this.parseExpression(args.expression);
		if (!expr.literal)
		{
			const data = await this.vice?.readMemory(expr.value, expr.size);
			if (data)
			{
				if (data.length <= 2 && !expr.array)
				{
					let n = 0;
					if (data.length === 1)
					{
						n = data[0];
					} else
					{
						n = data[0] | (data[1] << 8);
					}
					response.body = {
						result: new ViceValue(n, data.length * 8).toStringWithAddress(expr.value),
						variablesReference: 0
					};
				} else
				{
					let variableRef = 0;
					if (args.expression in this.variableRefsByName)
					{
						variableRef = this.variableRefsByName[args.expression];
					} else
					{
						variableRef = this.nextVariableRef++;
					}

					this.variableRefs[variableRef] = { data: data, address: expr.value };

					response.body = {
						result: new ViceValue(expr.value, 16).toString(),
						variablesReference: variableRef,
						indexedVariables: data.length
					};
				}
			} else
			{
				response.body = {
					result: expr.value.toString() ?? "<undefined>",
					variablesReference: 0
				};
			}
		} else
		{
			response.body = {
				result: expr.value.toString(),
				variablesReference: 0
			};
		}

		this.sendResponse(response);
	}

	protected override async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): Promise<void>
	{
		const expr = await this.parseExpression(args.expression);
		if (expr.literal)
		{
			return;
		}

		if (expr.size <= 2)
		{
			const newValue = ViceValue.fromString(args.value);
			const data: number[] = (expr.size === 1) ? [ newValue.value & 0xff ] : [ newValue.value & 0xff, newValue.value >> 8];
			await this.vice?.writeMemory(expr.value, data);
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
