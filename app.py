
import streamlit as st
import pandas as pd
from datetime import date, timedelta
import os

# --- Configuration --- #
DATA_FILE = 'stock_data.csv'

# --- Authentication --- #
def check_password():
    """Returns `True` if the user authenticates, else `False`."""

    def password_entered():
        """Checks whether a password entered by the user is correct."""
        if (st.session_state["username"] == st.secrets["credentials"]["username"] and
                st.session_state["password"] == st.secrets["credentials"]["password"]):
            st.session_state["password_correct"] = True
            del st.session_state["password"]  # Don't store password
            del st.session_state["username"]
        else:
            st.session_state["password_correct"] = False

    if "password_correct" not in st.session_state:
        # First run, show inputs for username + password.
        st.text_input("Username", on_change=password_entered, key="username")
        st.text_input("Password", type="password", on_change=password_entered, key="password")
        return False
    elif not st.session_state["password_correct"]:
        # Password incorrect, show input again
        st.text_input("Username", on_change=password_entered, key="username")
        st.text_input("Password", type="password", on_change=password_entered, key="password")
        st.error("ðŸš« User not known or password incorrect")
        return False
    else:
        # Password correct.
        return True

# --- Data Loading and Saving --- #
def load_data():
    if os.path.exists(DATA_FILE):
        df = pd.read_csv(DATA_FILE, parse_dates=['Date'])
        return df
    return pd.DataFrame(columns=['Date', 'Tab', 'Name', 'Opening', 'In', 'Issued', 'Return', 'Damage', 'Used', 'Stock', 'Note'])

def save_data(df):
    df.to_csv(DATA_FILE, index=False)

def get_data_for_date(df, selected_date, tab_name):
    df_filtered = df[(df['Date'] == pd.Timestamp(selected_date)) & (df['Tab'] == tab_name)].copy()
    return df_filtered

def get_latest_previous_stock(df, selected_date, tab_name):
    previous_dates_df = df[(df['Date'] < pd.Timestamp(selected_date)) & (df['Tab'] == tab_name)]
    if not previous_dates_df.empty:
        latest_date = previous_dates_df['Date'].max()
        latest_stock_df = previous_dates_df[previous_dates_df['Date'] == latest_date].copy()
        return latest_stock_df[['Name', 'Stock']].rename(columns={'Stock': 'Opening'})
    return pd.DataFrame(columns=['Name', 'Opening'])

# --- Main Application --- #
if check_password():
    st.set_page_config(layout="wide")
    st.title("ðŸ“š Inventory Management System")

    # Date selection
    selected_date = st.date_input("Select Date", value=date.today())

    # Tabs
    production_tab, packaging_tab = st.tabs(["Production", "Packaging"])

    with production_tab:
        st.header("Production Inventory")
        handle_inventory_tab("Production", selected_date)

    with packaging_tab:
        st.header("Packaging Inventory")
        handle_inventory_tab("Packaging", selected_date)

def handle_inventory_tab(tab_name, selected_date):
    all_data = load_data()
    current_day_data = get_data_for_date(all_data, selected_date, tab_name)

    if current_day_data.empty:
        st.info(f"No data found for {tab_name} on {selected_date}. Attempting to auto-rollover from previous day.")
        latest_previous_stock = get_latest_previous_stock(all_data, selected_date, tab_name)

        if not latest_previous_stock.empty:
            # Merge with a base structure to ensure all items are present
            # For simplicity, let's assume 'Name' column is consistent across days
            # If 'Name' can vary, a more robust merge/union logic is needed
            base_items = all_data[all_data['Tab'] == tab_name]['Name'].unique()
            if base_items.size > 0:
                base_df = pd.DataFrame({'Name': base_items})
                current_day_data = pd.merge(base_df, latest_previous_stock, on='Name', how='left')
                current_day_data['Opening'] = current_day_data['Opening'].fillna(0).astype(int)
            else:
                current_day_data = latest_previous_stock

            current_day_data['Date'] = pd.Timestamp(selected_date)
            current_day_data['Tab'] = tab_name
            current_day_data['In'] = 0
            current_day_data['Issued'] = 0
            current_day_data['Return'] = 0
            current_day_data['Damage'] = 0
            current_day_data['Used'] = 0
            current_day_data['Stock'] = current_day_data['Opening'] # Initial stock is opening
            current_day_data['Note'] = ''
            st.success("Auto-rollover successful. Please review and save.")
        else:
            st.warning(f"No previous data found for {tab_name} to rollover. Please add new items.")
            current_day_data = pd.DataFrame(columns=['Date', 'Tab', 'Name', 'Opening', 'In', 'Issued', 'Return', 'Damage', 'Used', 'Stock', 'Note'])

    # Ensure correct data types for editable columns
    numeric_cols = ['Opening', 'In', 'Issued', 'Return', 'Damage']
    for col in numeric_cols:
        if col in current_day_data.columns:
            current_day_data[col] = pd.to_numeric(current_day_data[col], errors='coerce').fillna(0).astype(int)

    # Display data editor
    edited_df = st.data_editor(
        current_day_data[['Name', 'Opening', 'In', 'Issued', 'Return', 'Damage', 'Used', 'Stock', 'Note']],
        column_config={
            "Used": st.column_config.NumberColumn(disabled=True),
            "Stock": st.column_config.NumberColumn(disabled=True),
        },
        num_rows="dynamic",
        hide_index=True,
        key=f"data_editor_{tab_name}_{selected_date}"
    )

    if st.button(f"Save {tab_name} Data", key=f"save_button_{tab_name}_{selected_date}"):
        # Apply calculations
        edited_df['Used'] = edited_df['Issued'] - edited_df['Return'] + edited_df['Damage']
        edited_df['Stock'] = (edited_df['Opening'] + edited_df['In']) - edited_df['Used']

        # Add Date and Tab columns for saving
        edited_df['Date'] = pd.Timestamp(selected_date)
        edited_df['Tab'] = tab_name

        # Reorder columns to match the original DataFrame structure for consistency
        final_df_to_save = edited_df[['Date', 'Tab', 'Name', 'Opening', 'In', 'Issued', 'Return', 'Damage', 'Used', 'Stock', 'Note']]

        # Remove old data for the selected date and tab, then append new data
        all_data_without_current_day = all_data[
            ~((all_data['Date'] == pd.Timestamp(selected_date)) & (all_data['Tab'] == tab_name))
        ]
        updated_all_data = pd.concat([all_data_without_current_day, final_df_to_save], ignore_index=True)
        save_data(updated_all_data)
        st.success(f"{tab_name} data saved successfully!")
        st.rerun()


