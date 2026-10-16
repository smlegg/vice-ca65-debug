import * as fs from 'fs';
import { lowerBound } from '@algorithm.ts/binary-search';
import * as vscode from 'vscode';
import * as path from 'path';

export interface DebugInfoLine
{
	file: number;
	line: number;
	spans: number[];
};

export interface DebugInfoModule
{
	name: string;
	file: number;
};

export interface DebugInfoSegment
{
	name: string;
	start: number;
	size: number;
};

export interface DebugInfoSpan
{
	segment: number;
	start: number;
	size: number;
};

export interface DebugInfoScope
{
	name: string;
	module: number;
	size: number | undefined;
	spans: number[];
	parent: number | undefined;
};

export type AddressSize = 'absolute' | 'zeropage';
export type SymbolType = 'lab' | 'equ' | 'imp';

export interface DebugInfoSymbol
{
	name: string;
	addrSize: AddressSize;
	size: number | undefined;
	scope: number | undefined;
	def: number | undefined;
	ref: number[];
	value: number | undefined;
	segment: number;
	type: SymbolType;
};

export interface SourceLocation
{
	fileName: string
	line: number
};

export interface AbsoluteSpan
{
	start: number;
	span: number;
};

export interface DebugValue
{
	value: number;
	size?: number;
	type: 'address' | 'literal';
}

export class DebugInfo
{
	files: string[] = [];
	lines: DebugInfoLine[] = [];
	modules: DebugInfoModule[] = [];
	segments: DebugInfoSegment[] = [];
	spans: DebugInfoSpan[] = [];
	scopes: DebugInfoScope[] = [];
	symbols: DebugInfoSymbol[] = [];
	orderedSpans: AbsoluteSpan[] = [];
	linesBySpan: {[span: number]: number[]} = {};
	fileLines: number[][] = [];
	labelsByName: {[name: string]: DebugInfoSymbol} = {};
	equatesByName: {[name: string]: DebugInfoSymbol} = {};

	public constructor(fileName: string)
	{
		const [workspaceFolder] = vscode.workspace.workspaceFolders || [];
		const rootPath = workspaceFolder?.uri.fsPath ?? "";

		const content = fs.readFileSync(fileName, 'utf-8');
		const lines = content.split(/\r?\n/);
		for (const line of lines)
		{
			const [ cmd, cmdParams ] = line.split('\t');
			let params: { [name: string]: string } = {};
			if (cmdParams)
			{
				for (const p of cmdParams.split(','))
				{
					const [ name, value ] = p.split('=');
					params[name] = value;
				}
			}
			switch (cmd)
			{
				case 'file':
					this.files[parseInt(params['id'])] = path.join(rootPath, params['name'].slice(1, -1));
					break;

				case 'line':
					this.lines[parseInt(params['id'])] = {
						file: parseInt(params['file']),
						line: parseInt(params['line']),
						spans: params['span'] ? Array.from(params['span'].split('+'), (x) => parseInt(x)) : []
					};
					break;
				case 'mod':
					this.modules[parseInt(params['id'])] = {
						name: params['name'].slice(1, -1),
						file: parseInt(params['file'])
					};
					break;
				case 'seg':
					this.segments[parseInt(params['id'])] = {
						name: params['name'].slice(1, -1),
						start: parseInt(params['start']),
						size: parseInt(params['size'])
					};
					break;
				case 'span':
					this.spans[parseInt(params['id'])] = {
						segment: parseInt(params['seg']),
						start: parseInt(params['start']),
						size: parseInt(params['size'])
					};
					break;
				case 'scope':
					this.scopes[parseInt(params['id'])] = {
						name: params['name'].slice(1, -1),
						module: parseInt(params['mod']),
						size: params['size'] ? parseInt(params['size']) : undefined,
						spans: params['span'] ? Array.from(params['span'].split('+'), (x) => parseInt(x)) : [],
						parent: params['parent'] ? parseInt(params['parent']) : undefined
					};
					break;
				case 'sym':
					this.symbols[parseInt(params['id'])] = {
						name: params['name'].slice(1, -1),
						addrSize: params['addrsize'] as AddressSize,
						size: params['size'] ? parseInt(params['size']) : undefined,
						scope: params['scope'] ? parseInt(params['scope']) : undefined,
						def: params['def'] ? parseInt(params['def']) : undefined,
						ref: params['ref'] ? Array.from(params['ref'].split('+'), (x) => parseInt(x)) : [],
						value: params['val'] ? parseInt(params['val']) : undefined,
						segment: parseInt(params['seg']),
						type: params['type'] as SymbolType
					};
					break;
			}
		}

		for (const [index, span] of this.spans.entries())
		{
			const address = this.segments[span.segment].start + span.start;
			this.orderedSpans.push({ start: address, span: index });
		}
		this.orderedSpans.sort((a, b) => a.start - b.start);

		for (let i = 0; i < this.files.length; i++)
		{
			this.fileLines.push([]);
		}

		for (const [index, line] of this.lines.entries())
		{
			for (const span of line.spans)
			{
				if (!(span in this.linesBySpan))
				{
					this.linesBySpan[span] = [ index ];
				} else
				{
					this.linesBySpan[span].push(index);
				}
			}

			this.fileLines[line.file].push(index);
		}

		for (let fileLines of this.fileLines)
		{
			fileLines.sort((a, b) => this.lines[a].line - this.lines[b].line);
		}

		for (let sym of this.symbols)
		{
			const scope = sym.scope ? this.scopes[sym.scope] : undefined;
			const fullName = scope && scope.name.length ? `${scope.name}::${sym.name}` : sym.name;
			switch (sym.type)
			{
				case 'lab':
					this.labelsByName[fullName] = sym;
					break;

				case 'equ':
					this.equatesByName[fullName] = sym;
					break;
			}
		}
	}

	public sourceLocation(addr: number) : SourceLocation | undefined
	{
		const orderdSpanIndex = lowerBound(0, this.orderedSpans.length, x => this.orderedSpans[x].start - addr);
		if (orderdSpanIndex >= 0 && this.orderedSpans[orderdSpanIndex].span in this.linesBySpan)
		{
			for (const lineIndex of this.linesBySpan[this.orderedSpans[orderdSpanIndex].span])
			{
				const line = this.lines[lineIndex];
				const file = this.files[line.file];
				return { fileName: file, line: line.line };
			}
		}

		return undefined;
	}

	public address(location: SourceLocation) : number | undefined
	{
		const fileIndex = this.files.findIndex((f) => f === location.fileName);
		if (fileIndex < 0)
		{
			return undefined;
		}

		const fileLineIndex = lowerBound(0, this.fileLines[fileIndex].length, x  => this.lines[this.fileLines[fileIndex][x]].line - location.line);
		if (this.lines[this.fileLines[fileIndex][fileLineIndex]].line !== location.line)
		{
			return undefined;
		}

		const line = this.lines[this.fileLines[fileIndex][fileLineIndex]];
		const spanIndex = line.spans[0];
		if (!spanIndex)
		{
			return undefined;
		}

		const span = this.spans[spanIndex];

		return this.segments[span.segment].start + span.start;
	}

	public symbol(name: string) : DebugValue | undefined
	{
		if (name in this.labelsByName)
		{
			const sym = this.labelsByName[name];
			if (sym.value)
			{
				return {
					value: sym.value,
					size: sym.size,
					type: 'address'
				};
			}
		} else if (name in this.equatesByName)
		{
			const sym = this.equatesByName[name];
			if (sym.value)
			{
				return {
					value: sym.value,
					type: 'literal'
				};
			}
		}

		return undefined;
	}
}
