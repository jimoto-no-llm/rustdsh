const LOCALE_NS = "fixture.gamma";

function apply(ctx) {
	ctx.effect(() => {
		const dictionaries = [
			["zh", { gamma: "ガンマ {count}" }],
			["en", { gamma: "Gamma {count}" }],
		];
		for (const [locale, dict] of dictionaries) ctx.locale.register(LOCALE_NS, locale, dict);
	});
}

export { apply };
