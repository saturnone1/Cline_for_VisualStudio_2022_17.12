type ProtoFactory = ((...args: any[]) => any) & Record<string | symbol, any>

export const createProtoStub = (name: string): ProtoFactory => {
	const stubTarget = (() => undefined) as ProtoFactory

	return new Proxy(stubTarget, {
		get: (_target, property) => {
			if (property === "create") {
				return (value: Record<string, any> = {}) => value
			}

			if (property === "fromJson" || property === "fromBinary") {
				return (value: any) => value
			}

			if (property === "toJson" || property === "toBinary") {
				return (value: any) => value
			}

			if (property === "equals") {
				return (left: any, right: any) => JSON.stringify(left) === JSON.stringify(right)
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
		apply: (_target, _thisArg, [value]) => value,
	})
}
