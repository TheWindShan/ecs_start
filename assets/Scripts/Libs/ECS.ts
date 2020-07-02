export module ecs {
    
    type ComponentConstructor<T> = {
        tid: number;
        compName : string;
        new() : T;
    }
    /**
     * 组件可能是从组件缓存池中取出来的，这个时候组件中的数据是销毁前的数据，这可能会导致逻辑行为的不确定。
     * 所以在得到组件后要注意某些数据的初始化工作。
     */
    export abstract class IComponent {
        /**
         * 每类组件的唯一id
         */
        static tid: number = -1;
        /**
         * 组件名称。用作实体对象属性的key。
         */
        static compName: string = null;
    }
    //----------------------------------------------------------------------------------------------------
    export interface ISystem {

    }

    //----------------------------------------------------------------------------------------------------
    export interface IExecuteSystem extends ISystem {
        readonly group: Group<Entity>;
        init(): void;
        execute(dt: number): void;
    }
    //----------------------------------------------------------------------------------------------------
    export interface IReactiveSystem extends IExecuteSystem {

    }
    //----------------------------------------------------------------------------------------------------

    /**
     * 注册组件工具
     */
    /**
     * 组件类型id
     */
    let compTid = 0;
    /**
     * 组件构造函数
     */
    let componentConstructors = [];
    /**
     * 由于js打包会改变类名，所以这里必须手动传入组件的名称。
     * @param componentName 
     */
    export function register(componentName: string) {
        return function (ctor: ComponentConstructor<IComponent>) {
            if (ctor.tid === -1) {
                ctor.tid = compTid++;
                ctor.compName = componentName;
                componentConstructors.push(ctor);
            }
            else {
                throw new Error('already contain component ' + componentName);
            }
        }
    }

    export function getComponentConstructors() {
        return componentConstructors;
    }
    //----------------------------------------------------------------------------------------------------
    type ComponentAddOrRemove = (entity: Entity) => void;

    export class Context<E extends Entity> {

        /**
         * 组件缓存池
         */
        private componentPools: Array<Array<IComponent>> = null;
        /**
         * 实体对象缓存池
         */
        private entityPool: E[] = [];

        /**
         * 通过实体id查找实体对象
         */
        public eid2Entity: Map<number, E> = Object.create(null);

        /**
         * 当前Context下组件类型数量
         */
        public readonly totalComponents: number = 0;
        /**
         * 每个类型组件对应的构造函数
         */
        public readonly componentTypes: ComponentConstructor<IComponent>[];

        /**
         * 每个组件的添加和删除的动作都要派送到“关心”它们的group上。
         */
        public readonly componentAddOrRemove: Array<Array<ComponentAddOrRemove>> = null;

        private groups: Map<string, Group<E>> = Object.create(null);

        private entityConstructor: { new(context: Context<E>): E } = null;

        constructor(eCtor: { new(context: Context<E>): E }, componentConstructors: ComponentConstructor<IComponent>[]) {
            this.entityConstructor = eCtor;
            this.totalComponents = componentConstructors.length;
            this.componentTypes = componentConstructors;

            this.componentPools = new Array<Array<IComponent>>(this.totalComponents);
            this.componentAddOrRemove = new Array<Array<ComponentAddOrRemove>>(this.totalComponents);

            for (let i = 0; i < this.totalComponents; i++) {
                this.componentPools[i] = [];
                this.componentAddOrRemove[i] = [];
            }
            if (this.totalComponents > 60) {
                throw new Error('最多支持60种组件！');
            }
        }

        /**
         * 为了管理到每一个创建的Entity，需要通过Context去创建。
         */
        createEntity(): E {
            let entity = this.entityPool.pop() || new this.entityConstructor(this);
            entity.init(this);
            this.eid2Entity[entity.eid] = entity;
            return entity as E;
        }

        /**
         * 销毁实体。
         * 
         * Context会缓存销毁的实体，下次新建实体时会优先从缓存中拿。
         * @param entity 
         */
        destroyEntity(entity: E) {
            if (this.eid2Entity[entity.eid]) {
                entity.destroy();
                this.entityPool.push(entity);
                this.eid2Entity[entity.eid] = null;
            }
            else {
                console.warn('Context.destroyEntity. Entity already destroyed.', entity.eid);
            }
        }

        /**
         * 创建group，每个group只关心对应组件的添加和删除
         * @param matchCompTypeIds 
         * @param systemType e-表示ExecuteSystem，r-表示ReactiveSystem，c-表示在系统中自己手动调用createGroup创建的筛选规则
         */
        createGroup<E extends Entity>(matcher: Matcher, systemType: string = 'c'): Group<E> {
            let key = `${systemType}_${matcher.getKey()}`;
            let group = this.groups[key] as Group<E>;
            if (!group) {
                group = new Group<E>(matcher);
                this.groups[key] = group;
                let careComponentTypeIds = matcher.indices;
                for (let i = 0, len = careComponentTypeIds.length; i < len; i++) {
                    this.componentAddOrRemove[careComponentTypeIds[i]].push(group.onComponentAddOrRemove.bind(group));
                }
            }
            return group;
        }

        clear() {
            this.recycleEntities();
        }

        /**
         * 回收所有实体
         */
        recycleEntities() {
            for (let eid in this.eid2Entity) {
                this.eid2Entity[eid] && this.destroyEntity(this.eid2Entity[eid]);
            }
        }

        createComponent<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            let component = this.componentPools[ctor.tid].pop() || new this.componentTypes[ctor.tid];
            return component as T;
        }

        putComponent(componentTypeId: number, component: IComponent) {
            this.componentPools[componentTypeId].push(component);
        }

        /**
         * 实体身上组件有增删操作，广播通知对应的观察者。
         * @param entity 实体对象
         * @param componentTypeId 组件类型id
         */
        broadcastComponentAddOrRemove(entity: Entity, componentTypeId: number) {
            let events = this.componentAddOrRemove[componentTypeId];
            for (let i = events.length - 1; i >= 0; i--) {
                events[i](entity);
            }
        }

        getEntityByEid(eid: number): E {
            return this.eid2Entity[eid];
        }
    }
    //----------------------------------------------------------------------------------------------------

    export class Entity {
        /**
         * 实体id自增量
         */
        private static eid: number = 1;
        /**
         * 实体唯一标识
         */
        public readonly eid: number = -1;

        /**
         * 用来标识组件是否存在。
         * 
         * 在JavaScript中1左移最多30位，超过30位就溢出了。实际工程中组件的个数可能大于30个，所以用了数组，这样能描述更高位的数据。
         * 
         * Math.floor(组件类型id/30) -> 得到的是数组的索引，表示这个组件的位数据在这个索引下的数值里面
         * 
         * (1 << 组件类型id%30) -> 得到的是这个组件的“位”
         */
        private _componentFlag: number[] = [0, 0];
        get componentFlag() {
            return this._componentFlag;
        }

        public context: Context<Entity>;

        constructor() {
            this.eid = Entity.eid++;
        }

        init(context: Context<Entity>) {
            this.context = context;
        }

        /**
         * 根据组件id动态创建组件，并通知关心的系统。
         * 
         * 如果实体存在了这个组件，那么会先删除之前的组件然后添加新的。
         * 
         * 注意：不要直接new Component，new来的Component不会从Component的缓存池拿缓存的数据。
         * @param componentTypeId 组件id
         */
        addComponent<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            if (!this.context) {
                console.warn('entity already destroyed.', this.eid);
                return;
            }
            let componentTypeId = ctor.tid;
            if (this.hasComponent(ctor)) {
                this.removeComponent(ctor);
            }
            let component = this.context.createComponent(ctor);
            let idx = (componentTypeId / 30) >>> 0;
            let offset = componentTypeId % 30;
            this._componentFlag[idx] |= 1 << offset;
            // 将组件对象直接附加到实体对象身上，方便直接获取。
            this[ctor.compName] = component;
            this.context.broadcastComponentAddOrRemove(this, componentTypeId);
            return component;
        }

        getComponent<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            return this[ctor.compName];
        }

        hasComponent<T extends IComponent>(ctor: ComponentConstructor<T>): boolean {
            let idx = (ctor.tid / 30) >>> 0;
            let offset = ctor.tid % 30;
            return !!(this._componentFlag[idx] & (1 << offset));
        }

        removeComponent<T extends IComponent>(ctor: ComponentConstructor<T>) {
            if (this.hasComponent(ctor)) {
                let componentTypeId = ctor.tid;
                let component = this.getComponent(ctor);
                this.context.putComponent(componentTypeId, component);
                this[ctor.compName] = null;
                let idx = (componentTypeId / 30) >>> 0;
                let offset = componentTypeId % 30;
                this._componentFlag[idx] &= ~(1 << offset);
                this.context.broadcastComponentAddOrRemove(this, componentTypeId);
            }
        }

        /**
         * 销毁实体，这个过程会回收实体身上的所有组件。不建议在单个系统中调用这个方法销毁实体。可能会导致System的for循环遍历出现问题。
         * 最好在同一个销毁实体系统中调用这个方法。
         * 
         * 使用context.destroyEntity来回收实体，这样实体可以重复使用
         */
        destroy() {
            let ctor: ComponentConstructor<IComponent>;
            // TODO: 有没有更好的办法移除实体身上所有的组件。有的实体身上没几个组件，销毁时还是会执行totalComponents次判断。
            for (let i = this.context.totalComponents - 1; i >= 0; i--) {
                ctor = this.context.componentTypes[i];
                this.removeComponent(ctor);
            }
            this.context = null;
        }
    }
    //----------------------------------------------------------------------------------------------------

    export class Group<E extends Entity> {
        /**
         * 实体筛选规则
         */
        private matcher: Matcher;

        /**
         * 所有满足的实体，这个数组可能随时添加或移除实体。
         */
        private _matchEntities: E[] = [];
        get matchEntities() {
            return this._matchEntities;
        }
        /**
         * 当前group中实体的数量
         */
        private _count: number = 0;
        get count() {
            return this._count;
        }

        /**
         * 获取matchEntities中第一个实体
         */
        get entity(): E {
            return this.matchEntities[0];
        }

        constructor(matcher: Matcher) {
            this.matcher = matcher;
        }

        /**
         * 实体添加或删除组件回调
         * @param entity 实体对象
         */
        onComponentAddOrRemove(entity: E) {
            if (this.matcher.isMatch(entity)) { // 判断实体对象是否符合Group的筛选规则，即实体身上是否有Group关注的那几个组件
                this.addEntity(entity);
            }
            else {
                this.removeEntity(entity);
            }
        }

        /**
         * 实体身上每种类型的组件只能挂载1个，所以能保证实体被添加进group之后不会再被添加一遍，就不用判断实体是否已存在于matchEntities中。
         * @param entity 
         */
        addEntity(entity: E) {
            this._matchEntities.push(entity);
            this._count++;
        }

        removeEntity(entity: E) {
            let idx = this._matchEntities.indexOf(entity);
            if (idx >= 0) {
                this._matchEntities[idx] = this._matchEntities[this.count - 1];
                this._matchEntities.length--;
                this._count--;
            }
        }

        clearCollectedEntities() {
            this._matchEntities.length = 0;
            this._count = 0;
        }
    }

    abstract class BaseOf {
        protected componentFlag: number[] = [0, 0]; // 最多支持60个组件
        public indices: number[] = [];
        constructor(...args: number[]) {
            let componentTypeId = -1;
            for (let i = 0, len = args.length; i < len; i++) {
                componentTypeId = args[i];
                let idx = (componentTypeId / 30) >>> 0;
                let offset = componentTypeId % 30;
                this.componentFlag[idx] |= 1 << offset;

                if (this.indices.indexOf(args[i]) < 0) { // 去重
                    this.indices.push(args[i]);
                }
            }
            this.indices.sort((a, b) => { return a - b; }); // 对组件类型id进行排序，这样关注相同组件的系统就能共用同一个group
        }

        public toString(): string {
            return this.indices.join('-'); // 生成group的key
        }

        public abstract getKey(): string;

        public abstract isMatch(entity: Entity): boolean;
    }

    /**
     * 用于描述包含任意一个这些组件的实体
     */
    class AnyOf extends BaseOf {
        public isMatch(entity: Entity): boolean {
            return !!(entity.componentFlag[0] & this.componentFlag[0]) || !!(entity.componentFlag[1] & this.componentFlag[1]);
        }

        getKey() {
            return 'anyOf:' + this.toString();
        }
    }

    /**
     * 用于描述包含了“这些”组件的实体，这个实体除了包含这些组件还可以包含其他组件
     */
    class AllOf extends BaseOf {
        public isMatch(entity: Entity): boolean {
            return ((entity.componentFlag[0] & this.componentFlag[0]) === this.componentFlag[0])
                && ((entity.componentFlag[1] & this.componentFlag[1]) === this.componentFlag[1]);
        }

        getKey() {
            return 'allOf:' + this.toString();
        }
    }

    /**
     * 用于描述只包含指定组件的逻辑
     */
    class OnlyOf extends BaseOf {

        public getKey(): string {
            return 'onlyOf:' + this.toString();
        }

        public isMatch(entity: Entity): boolean {
            return (entity.componentFlag[0] === this.componentFlag[0]) && (entity.componentFlag[1] === this.componentFlag[1]);
        }
    }

    /**
     * 不包含所有这里面的组件（“与”关系）
     */
    class NoneAllOf extends AllOf {

        public getKey(): string {
            return 'noneAllOf:' + this.toString();
        }

        public isMatch(entity: Entity): boolean {
            return !super.isMatch(entity);
        }
    }

    export class Matcher {

        private rules: BaseOf[] = [];
        private _indices: number[] = null;
        /**
         * 匹配器关注的组件索引。在创建Group时，Context根据组件id去给Group关联组件的添加和移除事件。
         */
        public get indices() {
            if (this._indices === null) {
                this._indices = [];
                this.rules.forEach((rule) => {
                    Array.prototype.push.apply(this._indices, rule.indices);
                });
            }
            return this._indices;
        }

        public static get newInst() {
            return new Matcher();
        }

        /**
         * 组件间是或的关系，表示关注拥有任意一个这些组件的实体。
         * @param args 组件索引
         */
        public anyOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AnyOf(...newArgs));
            return this;
        }

        /**
         * 组件间是与的关系，表示关注拥有所有这些组件的实体。
         * @param args 组件索引
         */
        public allOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AllOf(...newArgs));
            return this;
        }

        /**
         * 表示关注只拥有这些组件的实体
         * @param args 组件索引
         */
        public onlyOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new OnlyOf(...newArgs));
            return this;
        }

        /**
         * 表示不包含所有这里面的组件（“与”关系）。
         * @param args 
         */
        public noneAllOf(...args: ComponentConstructor<IComponent>[]) {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new NoneAllOf(...newArgs));
            return this;
        }

        public getKey(): string {
            let s = '';
            for (let i = 0; i < this.rules.length; i++) {
                s += this.rules[i].getKey()
                if (i < this.rules.length - 1) {
                    s += '|'
                }
            }
            return s;
        }

        public isMatch(entity: Entity): boolean {
            if (this.rules.length === 1) {
                return this.rules[0].isMatch(entity);
            }
            else if (this.rules.length === 2) {
                return this.rules[0].isMatch(entity) && this.rules[1].isMatch(entity);
            }
            else if (this.rules.length === 3) {
                return this.rules[0].isMatch(entity) && this.rules[1].isMatch(entity) && this.rules[2].isMatch(entity);
            }
            else {
                for (let i = 0; i < this.rules.length; i++) {
                    if (!this.rules[i].isMatch(entity)) {
                        return false;
                    }
                }
                return true;
            }
        }
    }

    /**
     * 每一帧都会去执行的系统
     */
    export abstract class ExecuteSystem<E extends Entity> implements IExecuteSystem {

        /**
         * 当前系统关系的组件
         */
        public readonly group: Group<E>;
        protected context: Context<E> = null;

        /**
         * 缓存当前系统收集到的感兴趣的实体。
         */
        private buffer: E[] = [];

        /**
         * 帧时间
         */
        public dt: number = 0;

        constructor(context: Context<E>) {
            this.context = context;
            this.group = context.createGroup(this.filter(), 'e');
        }

        /**
         * 不需要经过group的判断，无条件执行。
         */
        init(): void {

        }

        execute(dt: number): void {
            this.dt = dt;
            /**
             * 加个缓冲层，这样在当前帧中如果有实体删除了组件，不会影响到当前帧_buffer中的实体，但是实体的组件被移除了会导致获取不到组件对象。
             * 在系统中尽量不要直接移除当前系统所关心实体的组价，如果移除了那么在当前系统中获取那个组件的时候还需要额外写if代码进行判断组件是否存在。
             */
            Array.prototype.push.apply(this.buffer, this.group.matchEntities);
            this.update(this.buffer);
            this.buffer.length = 0;
        }
        /**
         * 实体过滤规则
         * 
         * 根据提供的组件过滤实体。
         */
        abstract filter(): Matcher;
        abstract update(entities: E[]): void;
    }
    /**
     * 响应式的系统，每次执行完后都会移除当前收集的实体。
     * 
     * 如果实体添加组件后需要在ReactiveSystem里面执行，在修改组件数据的时候需要使用replace**修改组件数据的方法。
     * 
     * 可实现只执行一次的系统。
     */
    export abstract class ReactiveSystem<E extends Entity> implements IReactiveSystem {

        /**
         * 当前系统关系的组件
         */
        public readonly group: Group<E>;
        protected context: Context<E> = null;

        private buffer: E[] = [];

        constructor(context: Context<E>) {
            this.context = context;
            this.group = context.createGroup(this.filter(), 'r');
        }

        init() {

        }

        execute(dt: number): void {
            /**
             * 加个缓冲层，这样在当前帧中如果有实体删除了组件，不会影响到当前帧buffer中的实体
             */
            Array.prototype.push.apply(this.buffer, this.group.matchEntities);
            this.group.clearCollectedEntities();
            this.update(this.buffer);
            this.buffer.length = 0;
        }
        /**
         * 实体过滤规则
         * 
         * 根据提供的组件过滤实体。
         */
        abstract filter(): Matcher;
        abstract update(entities: E[]): void;
    }

    /**
     * 所有System的root。对游戏中的System遍历从这里开始。
     */
    export class RootSystem implements ISystem {
        private executeSystemFlows: IExecuteSystem[] = [];

        constructor() {

        }

        add(system: ISystem) {
            if (system instanceof System) { // 将嵌套的System都“摊平”，放在根System中进行遍历，减少execute的频繁进入退出。
                Array.prototype.push.apply(this.executeSystemFlows, system.executeSystems);
                system.executeSystems.length = 0;
            }
            else {
                this.executeSystemFlows.push(system as IExecuteSystem);
            }
            return this;
        }

        init() {
            for (let sys of this.executeSystemFlows) {
                sys.init();
            }
        }

        execute(dt: number) {
            for (let sys of this.executeSystemFlows) {
                if (sys.group.count > 0) { // 与System关联的Group如果没有实体，则不去执行这个System。
                    sys.execute(dt);
                }
            }
        }
    }

    /**
     * 系统组合器，用于将多个相同功能模块的系统逻辑上放在一起。System也可以嵌套System。
     */
    export class System implements ISystem {
        executeSystems: IExecuteSystem[] = [];

        constructor() {

        }

        add(system: ISystem) {
            if (system instanceof System) {
                Array.prototype.push.apply(this.executeSystems, system.executeSystems);
                system.executeSystems.length = 0;
            }
            else {
                this.executeSystems.push(system as IExecuteSystem);
            }
            return this;
        }
    }
}