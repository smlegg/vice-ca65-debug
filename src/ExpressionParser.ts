import { DebugInfo, DebugValue } from './DebugInfo.js';
import { ViceMonitor } from './ViceMonitor.js';
import moo from 'moo';

export interface Expression
{
	value: number;
	size: number;
	literal: boolean;
	array: boolean;
}

enum Operator
{
	Parenthesis,
	Subscript,
	FixPoint,
	Negation,
	Complement,
	Dereference,
	Multiply,
	Divide,
	Modulo,
	Add,
	Subtract,
	ShiftLeft,
	ShiftRight,
	And,
	Or,
	Xor
};

const OPERATOR_PRECEDENCE =
[
	1,		// Parenthesis
	5,		// Subscript
	6,		// FixPoint
	6,		// Negation
	6,		// Complement
	6,		// Dereference
	11,		// Multiply
	11,		// Divide
	11,		// Modulo
	13,		// Add
	13,		// Subtract
	15,		// ShiftLeft
	15,		// ShiftRight
	23,		// And
	25,		// Or
	27		// Xor
];

interface ExpressionContext
{
	debugInfo: DebugInfo | null
	monitor: ViceMonitor | null
	operatorStack: Operator[]
	operandStack: DebugValue[]
}

async function reduceTopOperator(context: ExpressionContext)
{
	const op = context.operatorStack.pop();
	switch (op)
	{
		case Operator.FixPoint:
			break;

		case Operator.Negation:
		{
			const val = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: -val.value,
				type: 'literal'
			});
			break;
		}

		case Operator.Complement:
		{
			const val = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: ~val.value,
				type: 'literal'
			});
			break;
		}

		case Operator.Dereference:
		{
			const val = context.operandStack.pop() as DebugValue;
			if (!context.monitor)
			{
				throw Error("cannot dereference value, no monitor");
			}
			const size = Math.min(2, val.size ?? 1);
			const mem = await context.monitor.readMemory(val.value, size);
			let result = 0;
			for (let i = 0; i < size; i++)
			{
				result |= (mem[i] << (i * 8));
			}
			context.operandStack.push({
				value: result,
				type: 'literal'
			});
			break;
		}

		case Operator.Multiply:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value * b.value,
				type: 'literal'
			});
			break;
		}

		case Operator.Divide:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: Math.floor(a.value / b.value),
				type: 'literal'
			});
			break;
		}

		case Operator.Modulo:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value % b.value,
				type: 'literal'
			});
			break;
		}

		case Operator.Add:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value + b.value,
				type: (a.type === 'address' || b.type === 'address') ? 'address' : 'literal'
			});
			break;
		}

		case Operator.Subtract:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value - b.value,
				type: a.type === 'address' ? 'address' : 'literal'
			});
			break;
		}

		case Operator.ShiftLeft:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value << b.value,
				type: 'literal'
			});
			break;
		}

		case Operator.ShiftRight:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value >> b.value,
				type: 'literal'
			});
			break;
		}

		case Operator.And:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value & b.value,
				type: 'literal'
			});
			break;
		}

		case Operator.Or:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value | b.value,
				type: 'literal'
			});
			break;
		}

		case Operator.Xor:
		{
			const b = context.operandStack.pop() as DebugValue;
			const a = context.operandStack.pop() as DebugValue;
			context.operandStack.push({
				value: a.value ^ b.value,
				type: 'literal'
			});
			break;
		}

		default:
			throw Error(`unhandled operator ${op}`);
	}
}

async function reduceByPrecedence(op: Operator, context: ExpressionContext)
{
	const opPrecedence = OPERATOR_PRECEDENCE[op];
	while (context.operatorStack.length)
	{
		const stackOp = context.operatorStack[context.operatorStack.length - 1];
		if (stackOp === Operator.Parenthesis)
		{
			break;
		}
		if (OPERATOR_PRECEDENCE[stackOp] >= opPrecedence)
		{
			break;
		}
		await reduceTopOperator(context);
	}
}

async function reduceByPrecedenceAndPush(op: Operator, context: ExpressionContext)
{
	await reduceByPrecedence(op, context);
	context.operatorStack.push(op);
}

async function reduceUntilMatch(op: Operator, context: ExpressionContext): Promise<boolean>
{
	while (context.operatorStack.length)
	{
		const stackOp = context.operatorStack[context.operatorStack.length - 1];
		if (stackOp === op)
		{
			context.operatorStack.pop();
			return true;
		}

		await reduceTopOperator(context);
	}
	return false;
}

async function acceptCloseParenthesis(context: ExpressionContext)
{
	while (true)
	{
		if (context.operatorStack.length === 0)
		{
			throw Error("unexpected ')'");
		}

		const op = context.operatorStack[context.operandStack.length - 1];
		switch (op)
		{
			case Operator.Parenthesis:
				context.operatorStack.pop();
				return;
		}

		await reduceTopOperator(context);
	}
}

function parseNumber(str: string): number
{
	let numStr = str;
	let radix = 10;
	if (str.startsWith("0x"))
	{
		numStr = str.substring(2);
		radix = 16;
	} else if (str.startsWith("$"))
	{
		numStr = str.substring(1);
		radix = 16;
	} else if (str.startsWith("%"))
	{
		numStr = str.substring(1);
		radix = 2;
	}

	const num = parseInt(numStr, radix);
	if (num === undefined)
	{
		throw Error(`invalid number "${str}"`);
	}
	return num;
}

function pushNumber(str: string, context: ExpressionContext)
{
	context.operandStack.push({
		value: parseNumber(str),
		type: 'literal'
	});
}

function pushSymbol(str: string, context: ExpressionContext)
{
	const sym = context.debugInfo?.symbol(str);
	if (sym !== undefined)
	{
		context.operandStack.push(sym);
	} else
	{
		const reg = context.monitor?.register(str);
		if (reg !== undefined)
		{
			context.operandStack.push({
				value: reg.value,
				size: reg.bits / 8,
				type: 'literal'
			});
		} else
		{
			throw Error(`unknown symbol "${str}"`);
		}
	}
}

export async function parseExpression(str: string, debugInfo: DebugInfo | null, monitor: ViceMonitor | null): Promise<Expression>
{
	const [expr, arraySize] = str.split(',');

	let lexer: moo.Lexer = moo.compile({
		WS: /[ \t]+/,
		number: /0x[0-9a-fA-F]*|0|[1-9][0-9]*|\$[0-9a-fA-F]*|%[01]*/,
		operator: /\+|-|\*|\/|%|<<|>>|&|\||\^|~/,
		symbol: /[_a-zA-Z][:_a-zA-Z]*/,
		lparen: '(',
		rparen: ')',
		lsub: '[',
		rsub: ']'
	});

	lexer.reset(expr);

	let context: ExpressionContext =
	{
		debugInfo: debugInfo,
		monitor: monitor,
		operandStack: [],
		operatorStack: []
	};

outer:
	while (true)
	{
unary:
		while (true)
		{
			const token = lexer.next();
			if (token === undefined)
			{
				break outer;
			}

			switch (token.type)
			{
				case 'WS':
					break;

				case 'number':
					pushNumber(token.value, context);
					break unary;

				case 'symbol':
					pushSymbol(token.value, context);
					break unary;

				case 'lparen':
					context.operatorStack.push(Operator.Parenthesis);
					break;

				case 'operator':
				{
					let op: Operator | undefined = undefined;
					switch (token.value)
					{
						case '+': op = Operator.FixPoint; break;
						case '-': op = Operator.Negation; break;
						case '*': op = Operator.Dereference; break;
						case '~': op = Operator.Complement; break;
					}

					if (op !== undefined)
					{
						await reduceByPrecedenceAndPush(op, context);
					} else
					{
						throw Error(`unexpected operator "${token.value}"`);
					}
					break;
				}

				default:
					throw Error(`unexpected token "${token.value}"`);
			}
		}

binary:
		while (true)
		{
			const token = lexer.next();
			if (token === undefined)
			{
				break outer;
			}

			switch (token.type)
			{
				case 'WS':
					break;

				case 'rparen':
					await acceptCloseParenthesis(context);
					break;

				case 'operator':
				{
					let op: Operator | undefined = undefined;
					switch (token.value)
					{
						case '+': op = Operator.Add; break;
						case '-': op = Operator.Subtract; break;
						case '*': op = Operator.Multiply; break;
						case '/': op = Operator.Divide;	break;
						case '%': op = Operator.Modulo; break;
						case '<<': op = Operator.ShiftLeft; break;
						case '>>': op = Operator.ShiftRight; break;
						case '&': op = Operator.And; break;
						case '|': op = Operator.Or; break;
						case '^': op = Operator.Xor; break;
					}

					if (op !== undefined)
					{
						await reduceByPrecedenceAndPush(op, context);
					} else
					{
						throw Error(`unexpected token "${token.value}"`);
					}

					break binary;
				}

				case 'lsub':
					await reduceByPrecedenceAndPush(Operator.Subscript, context);
					break binary;

				case 'rsub':
				{
					if (! await reduceUntilMatch(Operator.Subscript, context))
					{
						throw Error("unexpected ']");
					}
					if (context.operandStack.length < 2)
					{
						throw Error("invalid expression");
					}
					if (!monitor)
					{
						throw Error("cannot dereference value, no monitor");
					}
					const b = context.operandStack.pop() as DebugValue;
					const a = context.operandStack.pop() as DebugValue;
					const mem = await monitor.readMemory(a.value + b.value, 1);
					context.operandStack.push({
						value: mem[0],
						type: 'literal'
					});
					break;
				}

				default:
					throw Error(`unexpected token "${token.value}"`);
			}

		}
	}

	while (context.operatorStack.length)
	{
		await reduceTopOperator(context);
	}

	if (context.operandStack.length !== 1)
	{
		throw Error("invalid expression");
	}

	let type = context.operandStack[0].type;
	let size = context.operandStack[0].size ?? 1;
	let isArray = false;
	if (arraySize !== undefined)
	{
		const arraySizeResult = await parseExpression(arraySize, debugInfo, monitor);
		size = arraySizeResult.value;
		type = 'address';
		isArray = true;
	}

	return {
		value: context.operandStack[0].value,
		size: size,
		literal: type === 'literal',
		array: isArray
	};
}
