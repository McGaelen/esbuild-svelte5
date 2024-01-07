let num = $state(0);

export const counter = {
    get count() {
        return num;
    },
    increment() {
        num += 1;
    },
};
