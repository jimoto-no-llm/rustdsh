// This comment contains decoys that a regex-only scanner would pick up:
// ctx.locale.register("fixture.decoy", { en: { decoy: "not real" } });
// const en = { decoy: "not real" };

const SHARED_EN = {
	"shared.one": "One {name}",
	"shared.two": "Two",
};
const SHARED_ZH = {
	"shared.one": "一 {name}",
	"shared.two": "二",
};
const SUFFIX = "right";
const GUIDE_EN = [
	"line one",
	"line two",
].join("\n\n");
const GUIDE_ZH = [
	"行一",
	"行二",
].join("\n\n");
const NS_ALPHA = "fixture.alpha";
const NS_BETA = "fixture.beta";
const alphaEn = {
	...SHARED_EN,
	"template.value": `Hello ${SUFFIX}
second line`,
	"concat.value": "left" + "-" + SUFFIX,
	"joined.value": GUIDE_EN,
	"brace.value": "literal } brace {and} escaped \"quote\"",
};
const alphaZh = {
	...SHARED_ZH,
	"template.value": `こんにちは ${SUFFIX}
2行目`,
	"concat.value": "左" + "-" + SUFFIX,
	"joined.value": GUIDE_ZH,
	"brace.value": "literal } brace {and} escaped \"quote\"",
};
const betaEn = {
	beta: "Beta",
	"string.decoy": 'ctx.locale.register("fixture.string", { en: { fake: "x" } })',
};
const betaZh = {
	beta: "ベータ",
	"string.decoy": 'ctx.locale.register("fixture.string", { en: { fake: "x" } })',
};

function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS_ALPHA, { zh: alphaZh, en: alphaEn }));
	ctx.effect(() => ctx.locale.register(NS_BETA, { zh: betaZh, en: betaEn }));
}

export { apply };
