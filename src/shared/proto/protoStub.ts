type ProtoRecord = Record<string, unknown>

export interface ProtoFactory {
	<T>(value: T): T
	create<T extends ProtoRecord>(value?: T): T
	fromJson<T>(value: T): T
	fromJSON<T>(value: T): T
	fromBinary<T>(value: T): T
	toJson<T>(value: T): T
	toJSON<T>(value: T): T
	toBinary<T>(value: T): T
	equals(left: unknown, right: unknown): boolean
	[key: string]: unknown
	[key: symbol]: unknown
}

export const createProtoStub = (name: string): ProtoFactory => {
	const stubTarget = (<T>(value: T) => value) as ProtoFactory

	return new Proxy(stubTarget, {
		get: (_target, property) => {
			if (property === "create") {
				return <T extends ProtoRecord>(value: T = {} as T) => value
			}

			if (property === "fromJson" || property === "fromJSON" || property === "fromBinary") {
				return <T>(value: T) => value
			}

			if (property === "toJson" || property === "toJSON" || property === "toBinary") {
				return <T>(value: T) => value
			}

			if (property === "equals") {
				return (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
			}

			if (property === Symbol.toPrimitive) {
				return () => name
			}

			if (property === "toString") {
				return () => name
			}

			if (typeof property === "string") {
				return property
			}

			return undefined
		},
		apply: (_target, _thisArg, [value]: unknown[]) => value,
	})
}
