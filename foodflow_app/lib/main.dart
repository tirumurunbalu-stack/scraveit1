import 'package:flutter/material.dart';

void main() => runApp(const FeastlyApp());

const kInk = Color(0xFF1F1B24);
const kCream = Color(0xFFFFF8F3);
const kCoral = Color(0xFF1463D8);
const kGold = Color(0xFF1D9BF0);

class Food {
  const Food(this.name, this.description, this.price, this.emoji,
      {this.vegetarian = false});
  final String name, description, emoji;
  final int price;
  final bool vegetarian;
}

class Restaurant {
  const Restaurant(this.name, this.cuisine, this.eta, this.rating, this.emoji,
      this.menu);
  final String name, cuisine, eta, emoji;
  final double rating;
  final List<Food> menu;
}

final restaurants = <Restaurant>[
  Restaurant('Bombay Bowl', 'Indian · Bowls', '22–28 min', 4.8, '🍛', const [
    Food('Butter chicken bowl', 'Tandoori chicken, fragrant rice & salad', 329, '🍗'),
    Food('Paneer makhani bowl', 'Creamy tomato curry, rice & onion salad', 289, '🧀', vegetarian: true),
    Food('Masala fries', 'Crispy fries with tangy house masala', 149, '🍟', vegetarian: true),
  ]),
  Restaurant('Little Napoli', 'Italian · Pizza', '28–35 min', 4.7, '🍕', const [
    Food('Truffle mushroom pizza', 'Mozzarella, mushroom, truffle oil', 449, '🍕', vegetarian: true),
    Food('Spicy chicken pizza', 'Roast chicken, jalapeño & hot honey', 479, '🍕'),
    Food('Tiramisu cup', 'Espresso-soaked mascarpone cream', 239, '🍮', vegetarian: true),
  ]),
  Restaurant('Green Theory', 'Healthy · Salads', '18–24 min', 4.9, '🥗', const [
    Food('Harvest grain salad', 'Quinoa, avocado, greens & lemon tahini', 349, '🥗', vegetarian: true),
    Food('Protein power bowl', 'Grilled chicken, sweet potato & greens', 399, '🥙'),
    Food('Cold pressed orange', 'Fresh orange, carrot and ginger', 159, '🧃', vegetarian: true),
  ]),
];

class CartLine {
  CartLine(this.food, this.restaurant, [this.quantity = 1]);
  final Food food;
  final Restaurant restaurant;
  int quantity;
}

class FeastlyApp extends StatefulWidget {
  const FeastlyApp({super.key});
  @override
  State<FeastlyApp> createState() => _FeastlyAppState();
}

class _FeastlyAppState extends State<FeastlyApp> {
  final cart = <CartLine>[];
  String role = 'Customer';
  bool hasOrder = false;
  bool riderAccepted = false;
  bool restaurantAccepted = false;
  bool dishAvailable = true;

  void add(Food food, Restaurant restaurant) {
    setState(() {
      final existing = cart.where((line) => line.food.name == food.name).firstOrNull;
      if (existing != null) {
        existing.quantity++;
      } else {
        cart.add(CartLine(food, restaurant));
      }
    });
  }

  int get subtotal => cart.fold(0, (sum, line) => sum + line.food.price * line.quantity);
  int get itemCount => cart.fold(0, (sum, line) => sum + line.quantity);

  void orderPlaced() => setState(() {
        hasOrder = true;
        cart.clear();
      });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Feastly',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: kCream,
        colorScheme: ColorScheme.fromSeed(seedColor: kCoral, surface: kCream),
        appBarTheme: const AppBarTheme(backgroundColor: kCream, foregroundColor: kInk),
        textTheme: Theme.of(context).textTheme.apply(fontFamily: 'sans-serif', bodyColor: kInk),
      ),
      home: role == 'Customer'
          ? CustomerShell(app: this)
          : OperationsShell(app: this, role: role),
    );
  }
}

class CustomerShell extends StatefulWidget {
  const CustomerShell({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  State<CustomerShell> createState() => _CustomerShellState();
}

class _CustomerShellState extends State<CustomerShell> {
  int index = 0;
  @override
  Widget build(BuildContext context) {
    final pages = [HomePage(app: widget.app), OrdersPage(app: widget.app), AccountPage(app: widget.app)];
    return Scaffold(
      body: SafeArea(child: pages[index]),
      floatingActionButton: widget.app.itemCount == 0 || index == 1
          ? null
          : FloatingActionButton.extended(
              backgroundColor: kInk,
              foregroundColor: Colors.white,
              onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => CartPage(app: widget.app))),
              label: Text('View cart · ${widget.app.itemCount}'),
              icon: const Icon(Icons.shopping_bag_outlined),
            ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (value) => setState(() => index = value),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  String query = '';
  @override
  Widget build(BuildContext context) {
    final filtered = restaurants.where((r) => ('${r.name} ${r.cuisine}').toLowerCase().contains(query.toLowerCase())).toList();
    return CustomScrollView(slivers: [
      SliverToBoxAdapter(child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const CircleAvatar(backgroundColor: Color(0xFFFFE0D9), child: Icon(Icons.location_on_outlined, color: kCoral)),
            const SizedBox(width: 10),
            const Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Deliver to', style: Theme.of(context).textTheme.labelMedium), Text('Home · Indiranagar', style: Theme.of(context).textTheme.titleSmall)])),
            IconButton(onPressed: () {}, icon: const Icon(Icons.notifications_none)),
          ]),
          const SizedBox(height: 24),
          Text('Good evening, Arjun', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 5),
          const Text('What are you craving today?'),
          const SizedBox(height: 18),
          TextField(onChanged: (value) => setState(() => query = value), decoration: InputDecoration(
            hintText: 'Search restaurants or cuisines', prefixIcon: const Icon(Icons.search), filled: true, fillColor: Colors.white, border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
          )),
          const SizedBox(height: 18),
          Container(padding: const EdgeInsets.all(18), decoration: BoxDecoration(color: kInk, borderRadius: BorderRadius.circular(22)), child: Row(children: [
            const Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('FEAST20', style: TextStyle(color: kGold, fontWeight: FontWeight.bold, letterSpacing: 1)), SizedBox(height: 5), Text('20% off your first three orders', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)), SizedBox(height: 5), Text('Use code at checkout', style: TextStyle(color: Colors.white70))])),
            const Text('🛵', style: TextStyle(fontSize: 50)),
          ])),
          const SizedBox(height: 26),
          Text('Top picks near you', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        ]),
      )),
      SliverList.builder(itemCount: filtered.length, itemBuilder: (context, i) => RestaurantCard(restaurant: filtered[i], app: widget.app)),
      const SliverToBoxAdapter(child: SizedBox(height: 100)),
    ]);
  }
}

class RestaurantCard extends StatelessWidget {
  const RestaurantCard({super.key, required this.restaurant, required this.app});
  final Restaurant restaurant;
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
    child: InkWell(borderRadius: BorderRadius.circular(20), onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => MenuPage(restaurant: restaurant, app: app))), child: Ink(
      padding: const EdgeInsets.all(14), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20)),
      child: Row(children: [
        Container(width: 74, height: 74, alignment: Alignment.center, decoration: BoxDecoration(color: const Color(0xFFFFEEE8), borderRadius: BorderRadius.circular(16)), child: Text(restaurant.emoji, style: const TextStyle(fontSize: 38))),
        const SizedBox(width: 14), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(restaurant.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)), const SizedBox(height: 3), Text(restaurant.cuisine, style: const TextStyle(color: Colors.black54)), const SizedBox(height: 8), Row(children: [const Icon(Icons.star_rounded, color: kGold, size: 18), Text(' ${restaurant.rating}  ·  ${restaurant.eta}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12))]),
        ])), const Icon(Icons.chevron_right),
      ]),
    )),
  );
}

class MenuPage extends StatelessWidget {
  const MenuPage({super.key, required this.restaurant, required this.app});
  final Restaurant restaurant;
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(restaurant.name)),
    floatingActionButton: app.itemCount == 0 ? null : FloatingActionButton.extended(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => CartPage(app: app))), backgroundColor: kInk, foregroundColor: Colors.white, icon: const Icon(Icons.shopping_bag_outlined), label: Text('Cart · ${app.itemCount}')),
    body: ListView(padding: const EdgeInsets.all(20), children: [
      Text(restaurant.emoji, style: const TextStyle(fontSize: 58)), Text(restaurant.cuisine, style: const TextStyle(color: Colors.black54)), const SizedBox(height: 6), Row(children: [const Icon(Icons.star, color: kGold), Text(' ${restaurant.rating}  ·  ${restaurant.eta}')]),
      const SizedBox(height: 26), const Text('Popular items', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 21)), const SizedBox(height: 10),
      ...restaurant.menu.map((food) => FoodTile(food: food, restaurant: restaurant, app: app)), const SizedBox(height: 80),
    ]),
  );
}

class FoodTile extends StatelessWidget {
  const FoodTile({super.key, required this.food, required this.restaurant, required this.app});
  final Food food;
  final Restaurant restaurant;
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => Container(margin: const EdgeInsets.only(bottom: 12), padding: const EdgeInsets.all(14), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18)), child: Row(children: [
    Text(food.emoji, style: const TextStyle(fontSize: 36)), const SizedBox(width: 12), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(food.name, style: const TextStyle(fontWeight: FontWeight.w800)), const SizedBox(height: 4), Text(food.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Colors.black54)), const SizedBox(height: 7), Text('₹${food.price}', style: const TextStyle(fontWeight: FontWeight.bold)),
    ])), OutlinedButton(onPressed: () { app.add(food, restaurant); ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${food.name} added to cart'), duration: const Duration(seconds: 1))); }, child: const Text('ADD')),
  ]));
}

class CartPage extends StatefulWidget {
  const CartPage({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  State<CartPage> createState() => _CartPageState();
}

class _CartPageState extends State<CartPage> {
  bool offerApplied = false;
  bool online = true;
  @override
  Widget build(BuildContext context) {
    final discount = offerApplied ? 50 : 0;
    final total = widget.app.subtotal + 39 - discount;
    return Scaffold(appBar: AppBar(title: const Text('Your order')), body: widget.app.cart.isEmpty ? const Center(child: Text('Your cart is empty')) : ListView(padding: const EdgeInsets.all(20), children: [
      Text(widget.app.cart.first.restaurant.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)), const SizedBox(height: 12),
      ...widget.app.cart.map((line) => ListTile(contentPadding: EdgeInsets.zero, title: Text(line.food.name), subtitle: Text('₹${line.food.price} each'), trailing: Row(mainAxisSize: MainAxisSize.min, children: [IconButton(onPressed: () => setState(() { if (line.quantity > 1) line.quantity--; else widget.app.cart.remove(line); }), icon: const Icon(Icons.remove_circle_outline)), Text('${line.quantity}'), IconButton(onPressed: () => setState(() => line.quantity++), icon: const Icon(Icons.add_circle_outline))])) ,
      const Divider(height: 30),
      ListTile(leading: const Icon(Icons.local_offer_outlined), title: Text(offerApplied ? 'FEAST20 applied' : 'Apply FEAST20'), subtitle: const Text('Save ₹50 on this order'), trailing: TextButton(onPressed: () => setState(() => offerApplied = !offerApplied), child: Text(offerApplied ? 'REMOVE' : 'APPLY'))),
      ListTile(leading: const Icon(Icons.payments_outlined), title: const Text('Payment method'), subtitle: Text(online ? 'Online payment (demo)' : 'Cash on delivery'), trailing: Switch(value: online, onChanged: (value) => setState(() => online = value))),
      const Divider(height: 30), _bill('Item total', widget.app.subtotal), _bill('Delivery fee', 39), if (discount > 0) _bill('Offer discount', -discount), const SizedBox(height: 8), _bill('To pay', total, bold: true), const SizedBox(height: 22),
      FilledButton(style: FilledButton.styleFrom(backgroundColor: kCoral, padding: const EdgeInsets.all(17)), onPressed: () { widget.app.orderPlaced(); Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => OrderSuccessPage(total: total)), (route) => route.isFirst); }, child: Text('Place order · ₹$total')),
    ]));
  }
  Widget _bill(String label, int value, {bool bold = false}) => Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(label, style: TextStyle(fontWeight: bold ? FontWeight.bold : FontWeight.normal)), Text('${value < 0 ? '-' : ''}₹${value.abs()}', style: TextStyle(fontWeight: bold ? FontWeight.bold : FontWeight.normal))]));
}

class OrderSuccessPage extends StatelessWidget {
  const OrderSuccessPage({super.key, required this.total});
  final int total;
  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Padding(padding: const EdgeInsets.all(30), child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [const Text('🎉', style: TextStyle(fontSize: 70)), const SizedBox(height: 18), const Text('Order confirmed!', style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold)), const SizedBox(height: 10), Text('Your food will arrive in about 28 minutes.\nTotal: ₹$total', textAlign: TextAlign.center), const SizedBox(height: 25), FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Track your order'))])));
}

class OrdersPage extends StatelessWidget {
  const OrdersPage({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.all(20), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('Your orders', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold)), const SizedBox(height: 20), if (app.hasOrder) _activeOrder(context), const SizedBox(height: 12), const Text('Past orders', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)), const SizedBox(height: 10), Container(padding: const EdgeInsets.all(16), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18)), child: const ListTile(contentPadding: EdgeInsets.zero, leading: Text('🍕', style: TextStyle(fontSize: 32)), title: Text('Little Napoli'), subtitle: Text('2 items · Delivered 12 Aug'), trailing: Text('₹718', style: TextStyle(fontWeight: FontWeight.bold)))),
  ]));
  Widget _activeOrder(BuildContext context) => Container(padding: const EdgeInsets.all(18), decoration: BoxDecoration(color: const Color(0xFFFFE8E3), borderRadius: BorderRadius.circular(20)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('ORDER #FT-2847', style: TextStyle(fontSize: 12, letterSpacing: 1, fontWeight: FontWeight.bold, color: kCoral)), const SizedBox(height: 8), const Text('Bombay Bowl is preparing your food', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17)), const SizedBox(height: 12), const LinearProgressIndicator(value: .42, color: kCoral), const SizedBox(height: 8), const Text('Estimated arrival: 26 min'), const SizedBox(height: 10), TextButton(onPressed: () => showModalBottomSheet(context: context, builder: (_) => const Padding(padding: EdgeInsets.all(24), child: Text('Live map tracking is ready for a Maps API key in the production setup.'))), child: const Text('View live tracking'))]));
}

class AccountPage extends StatelessWidget {
  const AccountPage({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(20), children: [const CircleAvatar(radius: 34, backgroundColor: Color(0xFFFFDFD9), child: Text('A', style: TextStyle(fontSize: 28, color: kCoral))), const SizedBox(height: 12), const Center(child: Text('Arjun Mehta', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold))), const SizedBox(height: 24), ...['Manage addresses', 'Payment methods', 'Help & support'].map((title) => ListTile(leading: const Icon(Icons.chevron_right), title: Text(title), trailing: const Icon(Icons.arrow_forward_ios, size: 15))), const Divider(), ListTile(leading: const Icon(Icons.switch_account_outlined), title: const Text('App mode'), subtitle: Text('Currently ${app.role}'), trailing: DropdownButton<String>(value: app.role, underline: const SizedBox(), items: const [DropdownMenuItem(value: 'Customer', child: Text('Customer')), DropdownMenuItem(value: 'Rider', child: Text('Rider')), DropdownMenuItem(value: 'Restaurant', child: Text('Restaurant'))], onChanged: (value) => value == null ? null : app.setState(() => app.role = value))),]);
}

class OperationsShell extends StatelessWidget {
  const OperationsShell({super.key, required this.app, required this.role});
  final _FeastlyAppState app;
  final String role;
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(role == 'Rider' ? 'Rider hub' : 'Bombay Bowl')), body: role == 'Rider' ? RiderPage(app: app) : RestaurantPage(app: app), bottomNavigationBar: SafeArea(child: Padding(padding: const EdgeInsets.all(12), child: OutlinedButton.icon(onPressed: () => app.setState(() => app.role = 'Customer'), icon: const Icon(Icons.person_outline), label: const Text('Switch to customer app'))));
}

class RiderPage extends StatelessWidget {
  const RiderPage({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(20), children: [const Text('Hi, Rahul 👋', style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold)), const Text('You are online and ready for orders.'), const SizedBox(height: 20), Row(children: [_stat('Today', '₹820'), const SizedBox(width: 12), _stat('Deliveries', '6')]), const SizedBox(height: 25), const Text('New delivery request', style: TextStyle(fontSize: 19, fontWeight: FontWeight.bold)), const SizedBox(height: 10), Container(padding: const EdgeInsets.all(18), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('Bombay Bowl → Indiranagar', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17)), const SizedBox(height: 8), const Text('2.7 km · Estimated earning ₹54'), const SizedBox(height: 15), FilledButton(onPressed: () => app.setState(() => app.riderAccepted = true), style: FilledButton.styleFrom(backgroundColor: kCoral), child: Text(app.riderAccepted ? 'Delivery accepted · Go to restaurant' : 'Accept delivery'))])), if (app.riderAccepted) Padding(padding: const EdgeInsets.only(top: 18), child: Container(padding: const EdgeInsets.all(18), decoration: BoxDecoration(color: const Color(0xFFFFE8E3), borderRadius: BorderRadius.circular(20)), child: const Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Current delivery', style: TextStyle(fontWeight: FontWeight.bold)), SizedBox(height: 8), Text('1. Reach restaurant\n2. Pick up order\n3. Deliver to customer'), SizedBox(height: 10), Text('Navigation opens when a Maps provider is connected.', style: TextStyle(fontSize: 12, color: Colors.black54))])))]);
  Widget _stat(String label, String value) => Expanded(child: Container(padding: const EdgeInsets.all(15), decoration: BoxDecoration(color: const Color(0xFFFFE8E3), borderRadius: BorderRadius.circular(18)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(label), Text(value, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.bold))])));
}

class RestaurantPage extends StatelessWidget {
  const RestaurantPage({super.key, required this.app});
  final _FeastlyAppState app;
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(20), children: [const Text('Today at a glance', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)), const SizedBox(height: 15), Row(children: [_stat('Orders', '18'), const SizedBox(width: 12), _stat('Sales', '₹8,240')]), const SizedBox(height: 25), const Text('Incoming order', style: TextStyle(fontSize: 19, fontWeight: FontWeight.bold)), const SizedBox(height: 10), Container(padding: const EdgeInsets.all(18), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('#FT-2847 · Arjun Mehta', style: TextStyle(fontWeight: FontWeight.bold)), const SizedBox(height: 8), const Text('1× Butter chicken bowl\n1× Masala fries'), const SizedBox(height: 12), FilledButton(onPressed: () => app.setState(() => app.restaurantAccepted = true), style: FilledButton.styleFrom(backgroundColor: kCoral), child: Text(app.restaurantAccepted ? 'Accepted · Preparing' : 'Accept order'))])), const SizedBox(height: 22), const Text('Menu availability', style: TextStyle(fontSize: 19, fontWeight: FontWeight.bold)), SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Butter chicken bowl'), subtitle: Text(app.dishAvailable ? 'Available to order' : 'Temporarily unavailable'), value: app.dishAvailable, onChanged: (value) => app.setState(() => app.dishAvailable = value))]);
  Widget _stat(String label, String value) => Expanded(child: Container(padding: const EdgeInsets.all(15), decoration: BoxDecoration(color: const Color(0xFFFFE8E3), borderRadius: BorderRadius.circular(18)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(label), Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold))])));
}

extension IterableFirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
